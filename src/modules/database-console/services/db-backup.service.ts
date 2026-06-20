import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Readable, Writable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { BackupDestinationsService } from '../../backups/services/backup-destinations.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import {
  DB_CONNECTION_RESOLVER,
  DbConnectionResolveInput,
  DbConnectionResolver,
} from '../interfaces/db-connection';

interface Creds {
  user?: string;
  database?: string;
  password?: string;
}

interface EngineStrategy {
  format: 'sql' | 'rdb';
  ext: string;
  contentType: string;
  dump: (c: Creds) => string[];
  /** null = logical restore is not available for this engine (use a volume snapshot). */
  restore: ((c: Creds) => string[]) | null;
}

export interface DbBackupInfo {
  engine: string;
  database: string | null;
  format: 'sql' | 'rdb' | null;
  supported: boolean;
  restoreSupported: boolean;
  reason: string | null;
  suggestedFilename: string;
}

export interface DbBackupS3Result {
  destinationId: string;
  bucket: string;
  key: string;
}

/** Single-quote a value for safe interpolation inside an `sh -c` script. */
function shq(v: string): string {
  const escaped = v.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

function requireSql(c: Creds): {
  user: string;
  database: string;
  password: string;
} {
  if (!c.user || !c.database || !c.password) {
    throw new BadRequestException(
      'Application is missing the user/database/password needed for a logical dump.',
    );
  }
  return { user: c.user, database: c.database, password: c.password };
}

/**
 * Per-engine logical backup strategy. Each command runs inside the DB pod via the engine's
 * own client (so the right tool/version is guaranteed) and streams through stdin/stdout.
 */
const STRATEGIES: Record<string, EngineStrategy> = {
  postgres: {
    format: 'sql',
    ext: 'sql',
    contentType: 'application/sql; charset=utf-8',
    dump: (c) => {
      const { user, database, password } = requireSql(c);
      return [
        'sh',
        '-c',
        `PGPASSWORD=${shq(password)} pg_dump -U ${shq(user)} -d ${shq(database)} ` +
          `--no-owner --no-privileges --clean --if-exists`,
      ];
    },
    restore: (c) => {
      const { user, database, password } = requireSql(c);
      return [
        'sh',
        '-c',
        `PGPASSWORD=${shq(password)} psql -U ${shq(user)} -d ${shq(database)} -v ON_ERROR_STOP=1`,
      ];
    },
  },
  mariadb: {
    format: 'sql',
    ext: 'sql',
    contentType: 'application/sql; charset=utf-8',
    dump: (c) => {
      const { user, database, password } = requireSql(c);
      const d = (bin: string) =>
        `MYSQL_PWD=${shq(password)} ${bin} -u${shq(user)} --single-transaction --skip-lock-tables ${shq(database)}`;
      return [
        'sh',
        '-c',
        `if command -v mariadb-dump >/dev/null 2>&1; then ${d('mariadb-dump')}; else ${d('mysqldump')}; fi`,
      ];
    },
    restore: (c) => {
      const { user, database, password } = requireSql(c);
      const r = (bin: string) =>
        `MYSQL_PWD=${shq(password)} ${bin} -u${shq(user)} ${shq(database)}`;
      return [
        'sh',
        '-c',
        `if command -v mariadb >/dev/null 2>&1; then ${r('mariadb')}; else ${r('mysql')}; fi`,
      ];
    },
  },
  // Redis/Valkey: an RDB snapshot streamed from the running instance. Logical restore from RDB
  // into a live instance isn't a stdin operation, so restore goes through a volume snapshot.
  redis: {
    format: 'rdb',
    ext: 'rdb',
    contentType: 'application/octet-stream',
    dump: (c) => {
      const auth = c.password ? `--no-auth-warning -a ${shq(c.password)} ` : '';
      return [
        'sh',
        '-c',
        `if command -v redis-cli >/dev/null 2>&1; then exec redis-cli ${auth}--rdb /dev/stdout; ` +
          `else exec valkey-cli ${auth}--rdb /dev/stdout; fi`,
      ];
    },
    restore: null,
  },
};
STRATEGIES.valkey = STRATEGIES.redis;

/**
 * Logical database backup/restore across engines. Produces an engine-native dump by exec-ing
 * the tool that ships in the DB image and streaming it out (HTTP download or S3); restores by
 * streaming a dump into the matching client's stdin. Reuses the console connection resolver
 * (engine + owner credentials + pod selector). Complements the block-level volume snapshots in
 * the applications/backups modules — engines without a logical path (e.g. FerretDB) fall back to
 * those. Restore is destructive and is gated by an explicit confirm at the controller.
 */
@Injectable()
export class DbBackupService {
  constructor(
    @Inject(DB_CONNECTION_RESOLVER)
    private readonly resolver: DbConnectionResolver,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
    private readonly destinations: BackupDestinationsService,
    private readonly storageFactory: StorageBackendFactory,
  ) {}

  async info(input: DbConnectionResolveInput): Promise<DbBackupInfo> {
    const r = await this.resolver.resolve(input);
    const strat = STRATEGIES[r.engine] ?? null;
    const db = r.credentials.database ?? null;
    const date = new Date().toISOString().slice(0, 10);

    let reason: string | null = null;
    if (!strat) {
      reason = `Logical backup is not yet supported for ${r.engine}. Use a volume snapshot instead.`;
    } else if (!strat.restore) {
      reason = `Logical restore is not available for ${r.engine}; restore via a volume snapshot.`;
    }

    return {
      engine: r.engine,
      database: db,
      format: strat?.format ?? null,
      supported: !!strat,
      restoreSupported: !!strat?.restore,
      reason,
      suggestedFilename: `${db ?? r.engine}-${date}.${strat?.ext ?? 'dump'}`,
    };
  }

  /** Stream a logical dump to `out`. */
  async dump(input: DbConnectionResolveInput, out: Writable): Promise<void> {
    const r = await this.resolver.resolve(input);
    const strat = STRATEGIES[r.engine];
    if (!strat) {
      throw new BadRequestException(
        `Logical backup is not supported for ${r.engine}.`,
      );
    }
    const kubeconfig = await this.clusters.getKubeconfig(r.target.clusterId);
    await this.kubernetes.execStream(
      kubeconfig,
      r.target.namespace,
      r.target.podLabelSelector,
      strat.dump(r.credentials),
      { stdout: out },
    );
  }

  /** Dump straight to an S3 backup destination (engine-agnostic). Returns the stored object. */
  async dumpToDestination(
    input: DbConnectionResolveInput,
    destinationId: string,
  ): Promise<DbBackupS3Result> {
    const info = await this.info(input);
    if (!info.supported) {
      throw new BadRequestException(
        info.reason ?? 'Logical backup not supported for this engine.',
      );
    }
    const dest = await this.destinations.findById(destinationId);
    const creds = this.destinations.toCredentials(dest);
    const backend = this.storageFactory.forProvider(dest.provider);
    const strat = STRATEGIES[info.engine];

    const tmp = join(
      tmpdir(),
      `flui-db-dump-${input.dbInstallId}-${Date.now()}.${info.format}`,
    );
    try {
      await this.dump(input, createWriteStream(tmp));
      const key = `db-dumps/${input.dbInstallId}/${info.suggestedFilename}`;
      const fullKey = await backend.uploadFile(
        creds,
        key,
        tmp,
        strat.contentType,
      );
      return { destinationId, bucket: creds.bucket, key: fullKey };
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  /** Restore a logical dump read from `body`. Destructive. */
  async restore(
    input: DbConnectionResolveInput,
    body: Readable,
  ): Promise<void> {
    const r = await this.resolver.resolve(input);
    const strat = STRATEGIES[r.engine];
    if (!strat?.restore) {
      throw new BadRequestException(
        `Logical restore is not available for ${r.engine}. Restore via a volume snapshot instead.`,
      );
    }
    const command = strat.restore(r.credentials);
    const kubeconfig = await this.clusters.getKubeconfig(r.target.clusterId);
    await this.kubernetes.execStream(
      kubeconfig,
      r.target.namespace,
      r.target.podLabelSelector,
      command,
      { stdin: body },
    );
  }
}
