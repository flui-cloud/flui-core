import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { ControlClusterService } from '../../infrastructure/control-cluster/control-cluster.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupDestinationsService } from './backup-destinations.service';
import { DestinationPlacementValidator } from './destination-placement.validator';
import { PlatformKeyBundleService } from './platform-key-bundle.service';

/** Magic for the framed encrypted dump: FLUIPB1\0 + iv(16) + ciphertext + gcm tag(16). */
const DUMP_MAGIC = Buffer.from('FLUIPB1\0', 'binary');
// pg_dumpall's TERMINAL trailer (the per-database `dump complete` line is NOT terminal
// and appears once per DB — checking it would pass a mid-run truncation).
const DUMP_CLUSTER_TRAILER = '-- PostgreSQL database cluster dump complete';

export interface PlatformBackupResult {
  dbObjectKey: string;
  keysObjectKey: string;
  databases: string[];
  zitadelCovered: boolean;
  insecureDefaults: string[];
  encryptionKeyFingerprint: string;
  dbSizeBytes: number;
  keysSizeBytes: number;
}

/**
 * Dumps the Flui master's own state (control Postgres via pg_dumpall) to an
 * off-provider bucket as TWO objects: the DB dump under a fresh per-run DEK, and
 * an age-sealed key bundle carrying that DEK plus the key material. The master
 * can never decrypt either — only the operator's offline age identity can.
 */
@Injectable()
export class PlatformBackupService {
  private readonly logger = new Logger(PlatformBackupService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly controlClusterService: ControlClusterService,
    private readonly clustersService: ClustersService,
    private readonly kubernetesService: KubernetesService,
    private readonly destinationsService: BackupDestinationsService,
    private readonly placementValidator: DestinationPlacementValidator,
    private readonly storageFactory: StorageBackendFactory,
    private readonly keyBundleService: PlatformKeyBundleService,
  ) {}

  async execute(
    policy: BackupPolicyEntity,
    destEntity: BackupDestinationEntity,
  ): Promise<PlatformBackupResult> {
    const recipient = policy.metadata?.platform?.recipient as
      | string
      | undefined;
    if (!recipient?.startsWith('age1')) {
      throw new BadRequestException(
        'Platform policy has no operator age recipient. Run `flui backup platform init` to generate one.',
      );
    }

    const control = await this.controlClusterService.getControlCluster();
    if (!control) {
      throw new BadRequestException('No control cluster found to back up.');
    }

    // The recovery bundle must not die with the master — enforce off-provider.
    await this.placementValidator.assertOffProviderStrict(
      control.provider,
      destEntity.id,
    );

    const kubeconfig = await this.clustersService.getKubeconfig(control.id);
    if (!kubeconfig) {
      throw new Error('Control cluster kubeconfig unavailable.');
    }
    // cluster.metadata.observabilityStack is only ever written by the legacy
    // in-process stack deploy (ControlClusterService.deployObservabilityStack);
    // the real bootstrap-scripts install never calls it, so that field is
    // reliably empty. The password does live in the pod's own env (fed from
    // its Secret), same as every other exec-based credential read in this
    // module — read it from there instead of a field nothing populates.
    const pgPassword = await this.resolvePgPassword(kubeconfig);
    if (!pgPassword) {
      throw new Error(
        'Control Postgres password not found in the postgres pod environment — cannot dump the master DB.',
      );
    }

    const dumpBuf = await this.runPgDumpall(kubeconfig, pgPassword);
    const databases = await this.listDatabases(kubeconfig, pgPassword);
    const zitadelCovered = databases.some((d) => /zitadel/i.test(d));

    const dek = crypto.randomBytes(32);
    const envId = control.id;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Relative to the destination's own pathPrefix: uploadFile() below already
    // prepends it (via GenericS3Backend.joinPrefix), so baking it in here too
    // would double it in the object key actually written to S3.
    const base = `platform/${envId}/${ts}`;

    const creds = this.destinationsService.toCredentials(destEntity);
    const backend = this.storageFactory.forProvider(destEntity.provider);

    // 1. Seal + upload the key bundle FIRST — if the (larger) DB upload then
    // fails, we orphan only a harmless sealed key blob, never an undecryptable
    // DB object.
    const bundle = await this.keyBundleService.assemble({
      recipient,
      dek,
      masterEnvId: envId,
      databases,
      zitadelCovered,
      kubeconfig,
    });
    const keysObjectKey = await this.uploadBuffer(
      backend,
      creds,
      `${base}/keys/keybundle.age`,
      bundle.ageBytes,
      'application/octet-stream',
    );

    // 2. Encrypted DB dump object (its DEK lives only inside the bundle above).
    const dumpCipher = this.frameEncryptedDump(gzipSync(dumpBuf), dek);
    const dbObjectKey = await this.uploadBuffer(
      backend,
      creds,
      `${base}/db/flui-pg.dump.gz.enc`,
      dumpCipher,
      'application/octet-stream',
    );

    this.logger.log(
      `[platform-backup] uploaded db(${dumpCipher.length}B) + keys(${bundle.ageBytes.length}B) to ${destEntity.name} under ${base}`,
    );

    return {
      dbObjectKey,
      keysObjectKey,
      databases,
      zitadelCovered,
      insecureDefaults: bundle.insecureDefaults,
      encryptionKeyFingerprint: bundle.encryptionKeyFingerprint,
      dbSizeBytes: dumpCipher.length,
      keysSizeBytes: bundle.ageBytes.length,
    };
  }

  private async runPgDumpall(
    kubeconfig: string,
    pgPassword: string,
  ): Promise<Buffer> {
    const cmd = [
      'sh',
      '-c',
      // --no-role-passwords: a rebuilt install has its own generated role
      // passwords in its own Secret. A dump carrying the OLD hashes overwrites
      // them on load and locks the new API out of the database it just
      // restored. The real passwords ride the sealed bundle instead.
      `PGPASSWORD=${this.shQuote(pgPassword)} pg_dumpall -U "$POSTGRES_USER" --clean --if-exists --no-role-passwords`,
    ];
    // Collect raw bytes — decoding per WS chunk would corrupt multibyte chars
    // straddling a chunk boundary and silently poison the restore.
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    await this.kubernetesService.execStream(
      kubeconfig,
      'flui-system',
      this.pgSelector(),
      cmd,
      { stdout: sink },
      this.pgContainer(),
    );
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) {
      throw new Error('pg_dumpall produced an empty dump.');
    }
    // The cluster trailer only appears once, at the very end — checking just the
    // tail rejects any truncation and can't be spoofed by user data mid-dump.
    if (!buf.subarray(-512).toString('utf-8').includes(DUMP_CLUSTER_TRAILER)) {
      throw new Error(
        'pg_dumpall did not reach the cluster dump trailer — refusing to persist a truncated dump.',
      );
    }
    return buf;
  }

  private async listDatabases(
    kubeconfig: string,
    pgPassword: string,
  ): Promise<string[]> {
    const cmd = [
      'sh',
      '-c',
      `PGPASSWORD=${this.shQuote(pgPassword)} psql -U "$POSTGRES_USER" -tAc ` +
        `"SELECT datname FROM pg_database WHERE datistemplate = false"`,
    ];
    try {
      const out = await this.kubernetesService.execInPod(
        kubeconfig,
        'flui-system',
        this.pgSelector(),
        this.pgContainer(),
        cmd,
      );
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch (err) {
      this.logger.warn(
        `[platform-backup] could not list databases: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** gzip → AES-256-GCM(dek) → FLUIPB1\0 + iv(16) + ciphertext + tag(16). */
  private frameEncryptedDump(gz: Buffer, dek: Buffer): Buffer {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([DUMP_MAGIC, iv, ct, tag]);
  }

  private async uploadBuffer(
    backend: ReturnType<StorageBackendFactory['forProvider']>,
    creds: ReturnType<BackupDestinationsService['toCredentials']>,
    key: string,
    data: Buffer,
    contentType: string,
  ): Promise<string> {
    // Only ciphertext ever touches disk; delete the temp file after upload.
    const tmp = path.join(
      os.tmpdir(),
      `flui-platform-${crypto.randomBytes(8).toString('hex')}`,
    );
    try {
      await fs.writeFile(tmp, data, { mode: 0o600 });
      // uploadFile() returns the full (pathPrefix-joined) key it wrote to;
      // callers that store this as an artifact location's objectKeyPrefix
      // need the relative key instead (getUsage/listObjects re-join pathPrefix).
      await backend.uploadFile(creds, key, tmp, contentType);
      return key;
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  private shQuote(v: string): string {
    const escaped = v.replaceAll("'", String.raw`'\''`);
    return `'${escaped}'`;
  }

  private async resolvePgPassword(kubeconfig: string): Promise<string | null> {
    const out = await this.kubernetesService.execInPod(
      kubeconfig,
      'flui-system',
      this.pgSelector(),
      this.pgContainer(),
      ['sh', '-c', 'printenv POSTGRES_PASSWORD'],
    );
    const pw = out.trim();
    return pw.length > 0 ? pw : null;
  }

  private pgSelector(): string {
    return this.configService.get<string>(
      'CONTROL_PG_LABEL_SELECTOR',
      'app=postgres',
    );
  }

  private pgContainer(): string | undefined {
    return this.configService.get<string>('CONTROL_PG_CONTAINER') || undefined;
  }
}
