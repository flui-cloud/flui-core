import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

export type RewireShape = 'external-secret-ref' | 'discrete-pg' | 'url-string';

export interface RewirePlan {
  shape: RewireShape;
  /** The full env array to persist on the consumer (DB entries rewritten, secrets already encrypted). */
  env: ApplicationEnvVar[];
  /** Masked human summary for the migration row / preview. */
  summary: string;
}

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

  private plain(dbApp: ApplicationEntity, name: string): string {
    const e = dbApp.env?.find((v) => v.name === name);
    if (!e)
      throw new BadRequestException(`DB app ${dbApp.slug} lacks env ${name}`);
    return e.secret ? this.encryption.decrypt(e.value) : e.value;
  }

  private dstConnection(dstDbApp: ApplicationEntity): PgConnection {
    return {
      host: this.svcHost(dstDbApp),
      port: '5432',
      db: this.plain(dstDbApp, 'POSTGRES_DB'),
      user: this.plain(dstDbApp, 'POSTGRES_USER'),
      password: this.plain(dstDbApp, 'POSTGRES_PASSWORD'),
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
  ): RewirePlan {
    const env = consumerApp.env ?? [];
    const srcHost = this.svcHost(srcDbApp);
    const dst = this.dstConnection(dstDbApp);

    if (
      env.some(
        (e) => e.externalSecretRef?.secretName === `${srcDbApp.slug}-secret`,
      )
    ) {
      throw new BadRequestException(
        'externalSecretRef DB link rewrite is not supported in v1 (self-contained apps only)',
      );
    }

    const pgHostEntry = env.find((e) => e.name === PG_DISCRETE.host);
    const pgAttributed =
      !!pgHostEntry && this.safeDecrypt(pgHostEntry) === srcHost;
    const pgNames: string[] = Object.values(PG_DISCRETE);
    const shapes = new Set<RewireShape>();

    const newEnv = env.map((e) => {
      const dv = this.safeDecrypt(e);
      if (dv !== undefined && this.isSrcUrl(dv, srcHost)) {
        shapes.add('url-string');
        const rebuilt = this.rebuildUrl(dv, dst);
        return {
          name: e.name,
          value: e.secret ? this.encryption.encrypt(rebuilt) : rebuilt,
          secret: e.secret,
        };
      }
      if (pgAttributed && pgNames.includes(e.name)) {
        shapes.add('discrete-pg');
        return this.rewriteDiscrete(e, dst);
      }
      return e;
    });

    if (shapes.size === 0) {
      throw new BadRequestException(
        `Cannot rewire app ${consumerApp.slug}: no env demonstrably points at the source DB ${srcHost} (need PGHOST or a postgres:// URL matching it)`,
      );
    }

    // Completeness: nothing may still reach the source after the rewrite.
    const dangling = newEnv.find((e) => {
      const dv = this.safeDecrypt(e);
      return dv !== undefined && (dv === srcHost || dv.includes(srcHost));
    });
    if (dangling) {
      throw new BadRequestException(
        `Cannot rewire app ${consumerApp.slug}: env ${dangling.name} still references the source DB ${srcHost} after rewrite — refusing to half-rewire`,
      );
    }

    return {
      shape: shapes.has('discrete-pg') ? 'discrete-pg' : 'url-string',
      env: newEnv,
      summary: `rewrote ${[...shapes].join('+')} → ${dst.host}:${dst.port}/${dst.db} (user ${dst.user})`,
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
  ): RewireShape {
    const env = consumerApp.env ?? [];
    const srcHost = this.svcHost(srcDbApp);
    if (
      env.some(
        (e) => e.externalSecretRef?.secretName === `${srcDbApp.slug}-secret`,
      )
    ) {
      throw new BadRequestException(
        'externalSecretRef DB link rewrite is not supported in v1 (self-contained apps only)',
      );
    }
    const pgHost = env.find((e) => e.name === PG_DISCRETE.host);
    if (pgHost && this.safeDecrypt(pgHost) === srcHost) {
      return 'discrete-pg';
    }
    if (env.some((e) => this.isSrcUrl(this.safeDecrypt(e), srcHost))) {
      return 'url-string';
    }
    throw new BadRequestException(
      `Cannot rewire app ${consumerApp.slug}: no env demonstrably points at the source DB ${srcHost} (need PGHOST or a postgres:// URL matching it)`,
    );
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
    return `${u.protocol}//${user}:${pw}@${dst.host}:${dst.port}/${dst.db}${u.search}`;
  }
}
