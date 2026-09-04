import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  ArtifactEngineFacts,
  ContinuousBackupEngine,
} from './continuous-backup-engine.interface';

/** The companion container that owns object-storage access for this engine. */
const SHIPPER_CONTAINER = 'flui-binlog-shipper';

interface MariadbTarget {
  kubeconfig: string;
  namespace: string;
  labelSelector: string;
  container: string;
  host: string;
  port: number;
  /** Root credential's env var inside the container — never read by Flui. */
  rootPasswordVar: string;
  user: string;
  database: string;
}

/**
 * Continuous backup for MariaDB: a base backup plus its binary logs.
 *
 * It differs from Postgres in one way that shapes everything here: MariaDB has
 * no `archive_command`. Postgres hands each finished segment to a command of
 * Flui's choosing, so shipping is the database's own job. MariaDB writes its
 * binary logs and forgets about them, so something has to be alive and reading
 * continuously — which is why this engine needs a companion process where
 * pgBackRest needed only a config file.
 *
 * Credentials follow the rule established with the Redis hook: every command
 * runs inside the workload's own container and authenticates from the
 * environment that container already has. Flui supplies object-storage
 * credentials and never an engine password.
 */
@Injectable()
export class MariadbPitrService implements ContinuousBackupEngine {
  private readonly logger = new Logger(MariadbPitrService.name);

  readonly engine = 'mariadb';
  readonly catalogSlug = 'mariadb';
  readonly restoreEnvPrefix = 'FLUI_MARIADB_';

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

  async resolveTarget(appId: string): Promise<MariadbTarget> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    }
    return {
      kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
      namespace: app.k8sNamespace,
      labelSelector: `flui-app-id=${app.id}`,
      container: app.slug,
      host: '127.0.0.1',
      port: 3306,
      rootPasswordVar: 'MARIADB_ROOT_PASSWORD',
      user: this.envValue(app, 'MARIADB_USER') ?? 'root',
      database: this.envValue(app, 'MARIADB_DATABASE') ?? 'mysql',
    };
  }

  /**
   * Runs a script in the shipper rather than the database.
   *
   * Refuses clearly when the shipper is absent instead of failing on a missing
   * binary: the fix for "this MariaDB predates the shipper" is a redeploy, and
   * a message about `rclone: not found` sends people looking for the wrong one.
   */
  private async execInShipper(
    target: MariadbTarget,
    script: string,
  ): Promise<string> {
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    try {
      return await this.k8s.execInPod(
        target.kubeconfig,
        target.namespace,
        target.labelSelector,
        SHIPPER_CONTAINER,
        ['sh', '-c', `echo ${b64} | base64 -d | sh`],
      );
    } catch (err: any) {
      if (/container .* not found|NotFound/i.test(err?.message ?? '')) {
        throw new BadRequestException(
          'This MariaDB has no backup shipper alongside it, so it cannot take ' +
            'a base backup. Redeploy the application to pick up the current ' +
            'configuration.',
        );
      }
      throw err;
    }
  }

  private async exec(target: MariadbTarget, script: string): Promise<string> {
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    return this.k8s.execInPod(
      target.kubeconfig,
      target.namespace,
      target.labelSelector,
      target.container,
      ['sh', '-c', `echo ${b64} | base64 -d | sh`],
    );
  }

  /** A `mariadb` invocation that authenticates from the container's own env. */
  private client(target: MariadbTarget): string {
    return `mariadb -uroot -p"$${target.rootPasswordVar}" -N -B`;
  }

  private async query(
    target: MariadbTarget,
    sql: string,
  ): Promise<string | undefined> {
    try {
      const out = await this.exec(
        target,
        `${this.client(target)} -e ${JSON.stringify(sql)}`,
      );
      return out.trim().split('\n').pop()?.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Refuse before touching anything, and say which thing is wrong.
   *
   * The three failures need three different fixes and one message would send
   * people to the wrong one: a stopped database is started, a missing binary
   * means the wrong image, and `log_bin = OFF` means a restart — which is why
   * the catalog seed turns it on at birth, so that this branch is reached only
   * by instances that predate it.
   */
  async requireTooling(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);

    let tools: string;
    try {
      tools = await this.exec(
        target,
        'for t in mariadb-backup mariadb-binlog mariadb; do ' +
          'command -v "$t" >/dev/null 2>&1 || { echo "MISSING:$t"; exit 0; }; ' +
          'done; echo OK',
      );
    } catch (err: any) {
      if (/No running pod/i.test(err?.message ?? '')) {
        throw new BadRequestException(
          'This database is not running, so continuous backup cannot be set ' +
            'up on it. Start it and try again.',
        );
      }
      throw err;
    }
    const missing = /MISSING:(\S+)/.exec(tools);
    if (missing) {
      throw new BadRequestException(
        `This database cannot do continuous backup: its image does not ship ` +
          `${missing[1]}. Continuous backup needs a MariaDB installed from the ` +
          'Flui catalog. For a database running from another image, take ' +
          'backups of its volume instead.',
      );
    }

    const logBin = await this.query(target, 'SELECT @@log_bin');
    if (logBin !== '1') {
      throw new BadRequestException(
        'This MariaDB was created before Flui enabled binary logging, and ' +
          '`log_bin` cannot be turned on while the server runs. Redeploy the ' +
          'application to pick up the current configuration — it restarts the ' +
          'database — and then enable continuous backup.',
      );
    }
  }

  /**
   * Make the server ready to be backed up, and prove it before anything is
   * recorded.
   *
   * Three settings, all dynamic, all reversed by {@link disable}:
   *
   * `binlog_format = ROW` because statement replay can diverge on
   * non-deterministic statements, and that failure looks like a successful
   * restore holding subtly wrong data.
   *
   * `sync_binlog = 1` because the default lets a host crash lose committed
   * transactions from the binary log that InnoDB has already kept — the
   * recovery window would then be missing writes the database itself still has.
   *
   * `binlog_expire_logs_seconds = 0` because the server's own ten-day purge
   * knows nothing about what has been shipped. With it at zero the disk fills
   * if shipping stalls, which is loud; with it left alone the recovery window
   * silently develops a hole that is discovered during a restore.
   */
  async enable(
    appId: string,
    _destination: BackupDestinationEntity,
    _opts?: { retentionFull?: number },
  ): Promise<void> {
    await this.requireTooling(appId);
    const target = await this.resolveTarget(appId);
    await this.exec(
      target,
      [
        'set -e',
        `${this.client(target)} -e "SET GLOBAL binlog_format = 'ROW'"`,
        `${this.client(target)} -e "SET GLOBAL sync_binlog = 1"`,
        `${this.client(target)} -e "SET GLOBAL binlog_expire_logs_seconds = 0"`,
        `${this.client(target)} -e "FLUSH BINARY LOGS"`,
      ].join('\n'),
    );
    this.logger.log(
      `[mariadb-pitr] prepared app=${appId} for continuous backup`,
    );
  }

  /**
   * Hand the server back its own defaults.
   *
   * Not optional cleanup. Leaving `binlog_expire_logs_seconds = 0` behind means
   * a database that never purges its binary logs again, and the volume fills —
   * an outage of the source, caused by a backup that was deleted.
   */
  async disable(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);
    await this.exec(
      target,
      [
        `${this.client(target)} -e "SET GLOBAL binlog_expire_logs_seconds = 864000" || true`,
        `${this.client(target)} -e "SET GLOBAL sync_binlog = 0" || true`,
      ].join('\n'),
    );
    this.logger.log(`[mariadb-pitr] released app=${appId}`);
  }

  async describeForArtifact(appId: string): Promise<ArtifactEngineFacts> {
    const target = await this.resolveTarget(appId);
    return {
      engine: this.engine,
      engineVersion: await this.query(target, 'SELECT VERSION()'),
      tool: 'mariadb-backup',
      toolVersion: (
        await this.exec(
          target,
          'mariadb-backup --version 2>&1 | head -1',
        ).catch(() => '')
      )
        .trim()
        .slice(0, 32),
      catalogSlug: this.catalogSlug,
      identities: { user: target.user, database: target.database },
      position: {
        gtid: (await this.query(target, 'SELECT @@gtid_binlog_pos')) ?? '',
      },
    };
  }

  /**
   * Takes a base backup and streams it straight to object storage.
   *
   * Run in the shipper container rather than the database's own, and that is
   * the point: the official MariaDB image has no way to talk to S3 — no rclone,
   * no curl, not even wget — so a base backup taken there would have to land on
   * the data volume first, doubling the space the database needs at the exact
   * moment it is being protected. The shipper mounts the same volume and has
   * both tools, so the backup never touches disk twice.
   *
   * The position it ends at is captured with it. Without that, the binary logs
   * are a pile of files with no declared point to start replaying from.
   */
  async baseBackup(appId: string): Promise<string> {
    const target = await this.resolveTarget(appId);
    const label = `base-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
    const out = await this.execInShipper(
      target,
      [
        'set -euo pipefail',
        '. /etc/flui/shipper/config',
        `LABEL="${label}"`,
        'DEST="$FLUI_S3_REMOTE/base/$FLUI_APP_ID/$LABEL"',
        // `--stream` writes to stdout, so nothing lands on the data volume.
        'mariadb-backup --backup --stream=mbstream ' +
          `--host=${target.host} --port=${target.port} ` +
          '--user=root --password="$MARIADB_ROOT_PASSWORD" ' +
          '2>/tmp/backup.log | rclone rcat "$DEST/base.mbstream" --s3-no-check-bucket',
        // Written by mariadb-backup to its log; it is the only thing that says
        // where the binary logs have to be replayed from.
        'POS=$(grep -oE "filename .[^\x27]+., position .[0-9]+." /tmp/backup.log | tail -1)',
        'echo "$POS" | rclone rcat "$DEST/binlog_info" --s3-no-check-bucket',
        'echo "FLUI_BASE_OK=$LABEL POS=$POS"',
      ].join('\n'),
    );
    if (!out.includes('FLUI_BASE_OK')) {
      throw new BadRequestException(
        'The base backup did not complete, so no restore point was created. ' +
          "Check the shipper container's logs.",
      );
    }
    this.logger.log(`[mariadb-pitr] base backup ${label} for app=${appId}`);
    return label;
  }

  /**
   * The window read from what actually reached object storage, never from the
   * server.
   *
   * The server knows what it wrote; only the repository knows what survived a
   * loss of the cluster, and that is the window a recovery can actually use.
   */
  async info(appId: string): Promise<{
    latestLabel: string | null;
    oldestRecoverable: string | null;
    newestRecoverable: string | null;
  }> {
    const target = await this.resolveTarget(appId);
    const out = await this.execInShipper(
      target,
      [
        '. /etc/flui/shipper/config 2>/dev/null || exit 0',
        'echo "BASES=$(rclone lsf "$FLUI_S3_REMOTE/base/$FLUI_APP_ID/" 2>/dev/null | tr -d / | sort | tr "\n" " ")"',
        'echo "LOGS=$(rclone lsf "$FLUI_S3_REMOTE/binlog/$FLUI_APP_ID/" 2>/dev/null | sort | tr "\n" " ")"',
      ].join('\n'),
    ).catch(() => '');

    const bases =
      /BASES=(.*)/.exec(out)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    const logs =
      /LOGS=(.*)/.exec(out)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    return {
      latestLabel: bases.at(-1) ?? null,
      // A base with no logs after it is a single point, not a window; a log
      // with no base before it cannot be replayed onto anything.
      oldestRecoverable: bases.length && logs.length ? bases[0] : null,
      newestRecoverable:
        bases.length && logs.length ? (logs.at(-1) ?? null) : null,
    };
  }

  buildRestoreEnv(): Record<string, string> {
    throw new BadRequestException(
      'Restoring a MariaDB point-in-time backup is not available yet.',
    );
  }
}
