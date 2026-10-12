import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  CONNECTION_URL_KEY,
  DIRECT_URL_KEY,
} from '../../attached-services/connection-url.core';
import { poolerHostOf } from '../../applications/utils/db-pooler.core';

export type RewireShape = 'external-secret-ref' | 'discrete-pg' | 'url-string';

export interface RewirePlan {
  shape: RewireShape;
  /** The full env array to persist on the consumer (DB entries rewritten, secrets already encrypted). */
  env: ApplicationEnvVar[];
  /** Masked human summary for the migration row / preview. */
  summary: string;
  /** The consumer reaches the destination through its pooler. */
  viaPooler?: boolean;
}

export interface RewireOptions {
  credentialsFrom?: ApplicationEntity;
  /** A `secretKeyRef` to the source's connection URL follows to the destination's Secret. */
  secretRefs?: boolean;
}

const SECRET_REF_KEYS = [CONNECTION_URL_KEY, DIRECT_URL_KEY];

interface PgConnection {
  host: string;
  port: string;
  db: string;
  user: string;
  password: string;
}

const PG_DISCRETE = {
  host: 'PGHOST',
  port: 'PGPORT',
  user: 'PGUSER',
  password: 'PGPASSWORD',
  db: 'PGDATABASE',
} as const;

/**
 * Rewrites a consumer app's Postgres connection env to point at a migrated
 * destination DB (which has a fresh host/db/user/password). Pure compute +
 * repository-level persist; never routes through ApplicationService.update
 * (which re-encrypts secret values → double-encryption) nor the PATCH DTO
 * (which strips externalSecretRef).
 */
@Injectable()
export class DbConnectionRewireService {
  private readonly logger = new Logger(DbConnectionRewireService.name);

  constructor(
    private readonly appsRepo: ApplicationsRepository,
    private readonly encryption: EncryptionService,
  ) {}

  private svcHost(dbApp: ApplicationEntity): string {
    return `${dbApp.slug}-svc.${dbApp.k8sNamespace}.svc.cluster.local`;
  }

  private poolerHost(dbApp: ApplicationEntity): string {
    return poolerHostOf(dbApp);
  }

  private plain(dbApp: ApplicationEntity, name: string): string {
    const e = dbApp.env?.find((v) => v.name === name);
    if (!e)
      throw new BadRequestException(`DB app ${dbApp.slug} lacks env ${name}`);
    return e.secret ? this.encryption.decrypt(e.value) : e.value;
  }

  private dstConnection(
    dstDbApp: ApplicationEntity,
    credentialsFrom: ApplicationEntity = dstDbApp,
  ): PgConnection {
    return {
      host: this.svcHost(dstDbApp),
      port: '5432',
      db: this.plain(credentialsFrom, 'POSTGRES_DB'),
      user: this.plain(credentialsFrom, 'POSTGRES_USER'),
      password: this.plain(credentialsFrom, 'POSTGRES_PASSWORD'),
    };
  }

  private decryptedValue(e: ApplicationEnvVar): string {
    return e.secret ? this.encryption.decrypt(e.value) : e.value;
  }

  /** Tolerant decrypt: bad ciphertext (an unrelated broken secret) → undefined, not a throw. */
  private safeDecrypt(e: ApplicationEnvVar): string | undefined {
    try {
      return this.decryptedValue(e);
    } catch {
      return undefined;
    }
  }

  private isSrcUrl(value: string | undefined, srcHost: string): boolean {
    return (
      !!value &&
      /^postgres(ql)?:\/\//i.test(value) &&
      this.urlHost(value) === srcHost
    );
  }

  /** The source's two addresses and where each lands on the destination. */
  private hostMap(
    srcDbApp: ApplicationEntity,
    dstDbApp: ApplicationEntity,
  ): Map<string, { host: string; pooled: boolean } | null> {
    return new Map([
      [this.svcHost(srcDbApp), { host: this.svcHost(dstDbApp), pooled: false }],
      [
        this.poolerHost(srcDbApp),
        dstDbApp.pooler?.enabled
          ? { host: this.poolerHost(dstDbApp), pooled: true }
          : null,
      ],
    ]);
  }

  private srcSecretRefs(
    env: ApplicationEnvVar[],
    srcDbApp: ApplicationEntity,
    opts: RewireOptions,
  ): ApplicationEnvVar[] {
    const refs = env.filter(
      (e) => e.externalSecretRef?.secretName === `${srcDbApp.slug}-secret`,
    );
    if (!refs.length) return [];
    if (!opts.secretRefs) {
      throw new BadRequestException(
        'externalSecretRef DB link rewrite is not supported in v1 (self-contained apps only)',
      );
    }
    const other = refs.find(
      (e) => !SECRET_REF_KEYS.includes(e.externalSecretRef?.key ?? ''),
    );
    if (other) {
      throw new BadRequestException(
        `Cannot rewire ${other.name}: it reads ${other.externalSecretRef?.key} from the database's Secret; only ${SECRET_REF_KEYS.join(' and ')} follow a migration`,
      );
    }
    return refs;
  }

  /**
   * Compute the rewrite. Attribution-gated: refuses to rewrite env that does
   * not demonstrably point at the SOURCE DB being migrated, and — after the
   * rewrite — refuses if ANY remaining entry still references the source (so a
   * consumer with both a URL and discrete PG*, or two URLs, can't be left half
   * rewired, silently reading the fenced source).
   */
  computeRewirePlan(
    consumerApp: ApplicationEntity,
    srcDbApp: ApplicationEntity,
    dstDbApp: ApplicationEntity,
    opts: RewireOptions = {},
  ): RewirePlan {
    const env = consumerApp.env ?? [];
    const hosts = this.hostMap(srcDbApp, dstDbApp);
    const srcHosts = [...hosts.keys()];
    const dst = this.dstConnection(dstDbApp, opts.credentialsFrom);
    const refs = new Set(this.srcSecretRefs(env, srcDbApp, opts));
    const target = (host: string) => {
      const to = hosts.get(host);
      if (to === null) {
        throw new BadRequestException(
          `Cannot rewire app ${consumerApp.slug}: it uses the pooler of ${srcDbApp.slug}, and the destination database has none`,
        );
      }
      return to;
    };

    const pgHostEntry = env.find((e) => e.name === PG_DISCRETE.host);
    const pgHost = pgHostEntry ? this.safeDecrypt(pgHostEntry) : undefined;
    const pgTarget =
      pgHost !== undefined && hosts.has(pgHost) ? target(pgHost) : undefined;
    const pgNames: string[] = Object.values(PG_DISCRETE);
    const shapes = new Set<RewireShape>();
    let viaPooler = false;

    const newEnv = env.map((e) => {
      if (refs.has(e)) {
        shapes.add('external-secret-ref');
        if (
          e.externalSecretRef?.key === CONNECTION_URL_KEY &&
          srcDbApp.pooler?.enabled &&
          srcDbApp.pooler.routed
        ) {
          viaPooler = true;
        }
        return {
          ...e,
          externalSecretRef: {
            ...e.externalSecretRef!,
            secretName: `${dstDbApp.slug}-secret`,
          },
        };
      }
      const dv = this.safeDecrypt(e);
      const urlHost = dv !== undefined ? this.srcUrlHost(dv, srcHosts) : null;
      if (dv !== undefined && urlHost) {
        shapes.add('url-string');
        const to = target(urlHost)!;
        viaPooler ||= to.pooled;
        const rebuilt = this.rebuildUrl(dv, { ...dst, host: to.host });
        return {
          name: e.name,
          value: e.secret ? this.encryption.encrypt(rebuilt) : rebuilt,
          secret: e.secret,
        };
      }
      if (pgTarget && pgNames.includes(e.name)) {
        shapes.add('discrete-pg');
        viaPooler ||= pgTarget.pooled;
        return this.rewriteDiscrete(e, {
          ...dst,
          host: pgTarget.host,
          port: e.name === PG_DISCRETE.port && dv ? dv : dst.port,
        });
      }
      return e;
    });

    if (shapes.size === 0) {
      throw new BadRequestException(
        `Cannot rewire app ${consumerApp.slug}: no env demonstrably points at the source DB ${srcHosts[0]} (need PGHOST or a postgres:// URL matching it)`,
      );
    }

    // Completeness: nothing may still reach the source after the rewrite.
    const dangling = newEnv.find((e) => {
      if (e.externalSecretRef?.secretName === `${srcDbApp.slug}-secret`) {
        return true;
      }
      const dv = this.safeDecrypt(e);
      return (
        dv !== undefined && srcHosts.some((h) => dv === h || dv.includes(h))
      );
    });
    if (dangling) {
      throw new BadRequestException(
        `Cannot rewire app ${consumerApp.slug}: env ${dangling.name} still references the source DB ${srcHosts[0]} after rewrite — refusing to half-rewire`,
      );
    }

    return {
      shape: dominantShape(shapes),
      env: newEnv,
      summary: `rewrote ${[...shapes].join('+')} → ${viaPooler ? this.poolerHost(dstDbApp) : dst.host}:${dst.port}/${dst.db} (user ${dst.user})`,
      viaPooler,
    };
  }

  /**
   * Create-time check (no destination yet): the consumer must have a
   * recognizable DB connection pointing at the source DB, or the migration is
   * rejected up front rather than at minute 40.
   */
  assertRewirable(
    consumerApp: ApplicationEntity,
    srcDbApp: ApplicationEntity,
    opts: Pick<RewireOptions, 'secretRefs'> = {},
  ): RewireShape {
    const env = consumerApp.env ?? [];
    const srcHost = this.svcHost(srcDbApp);
    const srcHosts = [srcHost, this.poolerHost(srcDbApp)];
    if (this.srcSecretRefs(env, srcDbApp, opts).length) {
      return 'external-secret-ref';
    }
    const pgHost = env.find((e) => e.name === PG_DISCRETE.host);
    const pgValue = pgHost ? this.safeDecrypt(pgHost) : undefined;
    if (pgValue !== undefined && srcHosts.includes(pgValue)) {
      return 'discrete-pg';
    }
    if (env.some((e) => this.srcUrlHost(this.safeDecrypt(e), srcHosts))) {
      return 'url-string';
    }
    throw new BadRequestException(
      `Cannot rewire app ${consumerApp.slug}: no env demonstrably points at the source DB ${srcHost} (need PGHOST or a postgres:// URL matching it)`,
    );
  }

  /** Whether an application reaches this database: its Secret, or either of its addresses. */
  referencesDb(app: ApplicationEntity, dbApp: ApplicationEntity): boolean {
    const hosts = [this.svcHost(dbApp), this.poolerHost(dbApp)];
    const short = [`${dbApp.slug}-svc`, `${dbApp.slug}-pooler`];
    return (app.env ?? []).some((e) => {
      if (e.externalSecretRef?.secretName === `${dbApp.slug}-secret`) {
        return true;
      }
      const v = this.safeDecrypt(e);
      if (v === undefined) return false;
      return (
        hosts.some((h) => v.includes(h)) ||
        short.includes(v) ||
        short.some((h) => v.includes(`${h}.${dbApp.k8sNamespace}`))
      );
    });
  }

  async applyRewirePlan(
    consumerAppId: string,
    plan: RewirePlan,
  ): Promise<void> {
    await this.appsRepo.update(consumerAppId, { env: plan.env });
    this.logger.log(
      `[rewire] ${consumerAppId}: ${plan.shape} — ${plan.summary}`,
    );
  }

  private rewriteDiscrete(
    e: ApplicationEnvVar,
    dst: PgConnection,
  ): ApplicationEnvVar {
    switch (e.name) {
      case PG_DISCRETE.host:
        return { name: e.name, value: dst.host, secret: false };
      case PG_DISCRETE.port:
        return { name: e.name, value: dst.port, secret: false };
      case PG_DISCRETE.user:
        return { name: e.name, value: dst.user, secret: false };
      case PG_DISCRETE.db:
        return { name: e.name, value: dst.db, secret: false };
      case PG_DISCRETE.password:
        // Upgrade to a real secret (destination password), single-encrypted.
        return {
          name: e.name,
          value: this.encryption.encrypt(dst.password),
          secret: true,
        };
      default:
        return e;
    }
  }

  private srcUrlHost(
    value: string | undefined,
    srcHosts: string[],
  ): string | null {
    return srcHosts.find((h) => this.isSrcUrl(value, h)) ?? null;
  }

  private urlHost(url: string): string | undefined {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }

  private rebuildUrl(url: string, dst: PgConnection): string {
    const u = new URL(url);
    const user = encodeURIComponent(dst.user);
    const pw = encodeURIComponent(dst.password);
    return `${u.protocol}//${user}:${pw}@${dst.host}:${u.port || dst.port}/${dst.db}${u.search}`;
  }
}

function dominantShape(shapes: ReadonlySet<RewireShape>): RewireShape {
  if (shapes.has('discrete-pg')) return 'discrete-pg';
  if (shapes.has('url-string')) return 'url-string';
  return 'external-secret-ref';
}
