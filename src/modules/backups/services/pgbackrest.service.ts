import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';

const DEFAULT_PGDATA = '/var/lib/postgresql/data/pgdata';
const PGBACKREST_STANZA = 'main';

export interface PgBackrestTarget {
  kubeconfig: string;
  namespace: string;
  labelSelector: string;
  container: string;
  pgdata: string;
  pgUser: string;
  pgDb: string;
  confPath: string;
}

export interface PgBackupInfo {
  /** Newest backup label, or null when the repo has no backups yet. */
  latestLabel: string | null;
  /**
   * Recoverable window from base backups: [oldest, newest] as ISO or null.
   * With archiving active the true newest edge is ~now (continuous WAL);
   * newestRecoverable understates it — do not gate restore targets on it.
   */
  oldestRecoverable: string | null;
  newestRecoverable: string | null;
  /** Completion time of the most recent FULL backup (drives full cadence). */
  lastFullAt: string | null;
  backupCount: number;
}

/**
 * Drives pgBackRest inside a managed Postgres pod over `kubectl exec`. Config +
 * WAL/base data live on the PVC (survives redeploys); credentials only ride the
 * one-time enable command. The Postgres image ships pgBackRest and is born with
 * archive_mode=on + a no-op archive_command, so enabling continuous backup is a
 * config write + ALTER SYSTEM reload — no restart.
 */
@Injectable()
export class PgBackrestService {
  private readonly logger = new Logger(PgBackrestService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
  ) {}

  private envValue(app: ApplicationEntity, name: string): string | undefined {
    return app.env?.find((e) => e.name === name)?.value;
  }

  async resolveTarget(appId: string): Promise<PgBackrestTarget> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster)
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    const pgdata = this.envValue(app, 'PGDATA') ?? DEFAULT_PGDATA;
    const pgUser = this.envValue(app, 'POSTGRES_USER') ?? 'postgres';
    const pgDb = this.envValue(app, 'POSTGRES_DB') ?? pgUser;
    return {
      kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
      namespace: app.k8sNamespace,
      labelSelector: `flui-app-id=${app.id}`,
      container: app.slug,
      pgdata,
      pgUser,
      pgDb,
      confPath: `${this.pvcRoot(pgdata)}/pgbackrest.conf`,
    };
  }

  private pvcRoot(pgdata: string): string {
    const idx = pgdata.lastIndexOf('/');
    return idx > 0 ? pgdata.slice(0, idx) : '/var/lib/postgresql/data';
  }

  private repoPath(dest: BackupDestinationEntity, appId: string): string {
    const prefix = (dest.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
    return `/${prefix ? prefix + '/' : ''}pgbackrest/${appId}`;
  }

  private buildConf(
    dest: BackupDestinationEntity,
    target: PgBackrestTarget,
    appId: string,
    retentionFull: number,
  ): string {
    const endpointHost = dest.endpoint.replace(/^https?:\/\//, '');
    const accessKey = this.encryption.decrypt(dest.accessKeyEncrypted);
    const secretKey = this.encryption.decrypt(dest.secretKeyEncrypted);
    const uriStyle = dest.forcePathStyle ? 'path' : 'host';
    return [
      '[global]',
      'repo1-type=s3',
      // The flui-postgres image ships ca-certificates so the S3 endpoint cert
      // is verified (no verify-tls=n).
      'repo1-storage-ca-file=/etc/ssl/certs/ca-certificates.crt',
      `repo1-s3-endpoint=${endpointHost}`,
      `repo1-s3-bucket=${dest.bucket}`,
      `repo1-s3-region=${dest.region}`,
      `repo1-s3-key=${accessKey}`,
      `repo1-s3-key-secret=${secretKey}`,
      `repo1-s3-uri-style=${uriStyle}`,
      `repo1-path=${this.repoPath(dest, appId)}`,
      `repo1-retention-full=${retentionFull}`,
      // Bundle many small relation files into few S3 objects — without this a
      // fresh cluster's ~1000+ files upload one PUT at a time (minutes → ~1min).
      'repo1-bundle=y',
      'process-max=4',
      'start-fast=y',
      'log-level-console=info',
      '',
      `[${PGBACKREST_STANZA}]`,
      `pg1-path=${target.pgdata}`,
      // pgBackRest connects to Postgres to verify a primary; the maintenance
      // role/db is the app's own user, not the default 'postgres'.
      `pg1-user=${target.pgUser}`,
      `pg1-database=${target.pgDb}`,
      '',
    ].join('\n');
  }

  private async exec(
    target: PgBackrestTarget,
    script: string,
  ): Promise<string> {
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    return this.k8s.execInPod(
      target.kubeconfig,
      target.namespace,
      target.labelSelector,
      target.container,
      ['sh', '-c', `echo ${b64} | base64 -d | sh`],
    );
  }

  /**
   * Idempotent: write the pgBackRest config, create the stanza, and flip
   * archive_command to push WAL — all without a restart.
   */
  async enable(
    appId: string,
    dest: BackupDestinationEntity,
    opts?: { retentionFull?: number },
  ): Promise<void> {
    const target = await this.resolveTarget(appId);
    const conf = this.buildConf(dest, target, appId, opts?.retentionFull ?? 2);
    const confB64 = Buffer.from(conf, 'utf-8').toString('base64');
    const archiveCommand = `pgbackrest --config=${target.confPath} --stanza=${PGBACKREST_STANZA} archive-push %p`;
    const script = [
      'set -e',
      'umask 077',
      `echo ${confB64} | base64 -d > ${target.confPath}`,
      `chown postgres:postgres ${target.confPath}`,
      `chmod 600 ${target.confPath}`,
      `gosu postgres pgbackrest --config=${target.confPath} --stanza=${PGBACKREST_STANZA} --log-level-console=info stanza-create`,
      `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET archive_command = '${archiveCommand}';"`,
      // Without archive_timeout WAL only ships on 16MB segment switches — on a
      // quiet database the recoverable edge can lag hours behind "now".
      `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET archive_timeout = '60s';"`,
      `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -c "SELECT pg_reload_conf();"`,
    ].join('\n');
    await this.exec(target, script);
    this.logger.log(`[pgbackrest] enabled continuous backup for app=${appId}`);
  }

  /**
   * Stop WAL shipping: back to the no-op archive_command the image is born
   * with. Without this, deleting a policy (or its destination/credentials)
   * leaves archive-push failing forever and Postgres retaining WAL until the
   * volume fills — an outage of the SOURCE database.
   */
  async disable(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);
    const script = [
      'set -e',
      `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET archive_command = '/bin/true';"`,
      `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -c "ALTER SYSTEM RESET archive_timeout;"`,
      `gosu postgres psql -U ${target.pgUser} -d ${target.pgDb} -v ON_ERROR_STOP=1 -c "SELECT pg_reload_conf();"`,
    ].join('\n');
    await this.exec(target, script);
    this.logger.log(`[pgbackrest] disabled continuous backup for app=${appId}`);
  }

  /** Run a base backup. `type` is full|incr|diff. Returns the new backup label. */
  async baseBackup(
    appId: string,
    type: 'full' | 'incr' | 'diff' = 'full',
  ): Promise<string> {
    const target = await this.resolveTarget(appId);
    await this.exec(
      target,
      [
        'set -e',
        `gosu postgres pgbackrest --config=${target.confPath} --stanza=${PGBACKREST_STANZA} --type=${type} --log-level-console=info backup`,
      ].join('\n'),
    );
    const info = await this.info(appId);
    if (!info.latestLabel) {
      throw new Error(
        'pgBackRest backup reported success but no backup in info',
      );
    }
    this.logger.log(
      `[pgbackrest] base backup ${info.latestLabel} for app=${appId}`,
    );
    return info.latestLabel;
  }

  /** Read the repo state + recoverable window from `pgbackrest info`. */
  async info(appId: string): Promise<PgBackupInfo> {
    const target = await this.resolveTarget(appId);
    const out = await this.exec(
      target,
      [
        `gosu postgres pgbackrest --config=${target.confPath} --stanza=${PGBACKREST_STANZA} info --output=json`,
      ].join('\n'),
    );
    return this.parseInfo(out);
  }

  /**
   * FLUI_PG_* env for a new install that boots in restore-bootstrap mode against
   * the given app's pgBackRest repo. Values ride envOverrides into the install;
   * the S3 secret lands in the app Secret once resolved. Target picks PITR,
   * restoreSet pins a backup label restored to its own consistency point
   * (as-of-that-backup); neither = latest (end of WAL).
   */
  buildRestoreEnv(
    sourceAppId: string,
    dest: BackupDestinationEntity,
    recoveryTargetTime?: Date | null,
    restoreSet?: string | null,
  ): Record<string, string> {
    const env: Record<string, string> = {
      FLUI_PG_RESTORE: '1',
      FLUI_PG_S3_ENDPOINT: dest.endpoint.replace(/^https?:\/\//, ''),
      FLUI_PG_S3_BUCKET: dest.bucket,
      FLUI_PG_S3_REGION: dest.region,
      FLUI_PG_S3_KEY: this.encryption.decrypt(dest.accessKeyEncrypted),
      FLUI_PG_S3_KEY_SECRET: this.encryption.decrypt(dest.secretKeyEncrypted),
      FLUI_PG_S3_URI_STYLE: dest.forcePathStyle ? 'path' : 'host',
      FLUI_PG_S3_PATH: this.repoPath(dest, sourceAppId),
    };
    if (recoveryTargetTime) {
      env.FLUI_PG_RESTORE_TARGET = this.toPgTimeTarget(recoveryTargetTime);
    } else if (restoreSet) {
      env.FLUI_PG_RESTORE_SET = restoreSet;
    }
    return env;
  }

  /** pgBackRest --target format: 'YYYY-MM-DD HH:MM:SS+00' (UTC). */
  private toPgTimeTarget(d: Date): string {
    return d.toISOString().slice(0, 19).replace('T', ' ') + '+00';
  }

  private parseInfo(json: string): PgBackupInfo {
    let stanzas: unknown;
    try {
      stanzas = JSON.parse(json);
    } catch {
      return {
        latestLabel: null,
        oldestRecoverable: null,
        newestRecoverable: null,
        lastFullAt: null,
        backupCount: 0,
      };
    }
    const stanza = Array.isArray(stanzas)
      ? (stanzas.find(
          (s: { name?: string }) => s?.name === PGBACKREST_STANZA,
        ) as { backup?: PgBackrestInfoBackup[] } | undefined)
      : undefined;
    const backups = stanza?.backup ?? [];
    if (backups.length === 0) {
      return {
        latestLabel: null,
        oldestRecoverable: null,
        newestRecoverable: null,
        lastFullAt: null,
        backupCount: 0,
      };
    }
    const toIso = (epoch?: number): string | null =>
      typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
    const first = backups[0];
    const last = backups.at(-1);
    let lastFull: PgBackrestInfoBackup | undefined;
    for (let i = backups.length - 1; i >= 0; i--) {
      if (backups[i].type === 'full') {
        lastFull = backups[i];
        break;
      }
    }
    return {
      latestLabel: last.label ?? null,
      // Consistency is only reached at the END of the oldest base backup —
      // targets inside its start..stop window are not recoverable.
      oldestRecoverable: toIso(first.timestamp?.stop),
      newestRecoverable: toIso(last.timestamp?.stop),
      lastFullAt: toIso(lastFull?.timestamp?.stop),
      backupCount: backups.length,
    };
  }
}

interface PgBackrestInfoBackup {
  label?: string;
  type?: string;
  timestamp?: { start?: number; stop?: number };
}
