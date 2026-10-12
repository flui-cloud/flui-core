import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { DB_ENGINE_LABEL } from '../../database-console/engine/engine-profile';
import {
  CONNECTION_URL_KEY,
  DIRECT_URL_KEY,
  composeConnectionUrls,
} from '../../attached-services/connection-url.core';
import { poolerHostOf } from '../../applications/utils/db-pooler.core';

/**
 * Puts a building block's connection URL where a consumer can read it without
 * anyone copying a password.
 *
 * The URL lives as one more secret env on the block's own application row, so
 * the existing Secret generation renders it into `<slug>-secret` with no change
 * to the manifest generator, and a consumer reaches it with a plain
 * `secretKeyRef`. That is the whole point: `fromService: url` never puts a
 * credential in the consumer's row, in a plan, or in a log.
 *
 * Two entry points, because there are two kinds of block:
 *   - `ensureAtGeneration` — a block being installed now. The env is written
 *     before its first deploy, so the URL is in the Secret the moment the Secret
 *     exists. Nothing is patched, nothing restarts.
 *   - `ensureOnExisting` — a block installed before this existed. Its Secret is
 *     already in the cluster, so the key is added to the live Secret as well as
 *     the row. Patching rather than redeploying is deliberate: rolling a
 *     database to give it a variable it does not itself read would be an outage
 *     for nothing.
 */
@Injectable()
export class BlockConnectionUrlService {
  private readonly logger = new Logger(BlockConnectionUrlService.name);

  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly encryption: EncryptionService,
    private readonly kubernetes: KubernetesService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  /** `<slug>-svc.<ns>.svc.cluster.local` — the same host every other linker uses. */
  static hostOf(app: ApplicationEntity): string {
    return `${app.slug}-svc.${app.k8sNamespace}.svc.cluster.local`;
  }

  /** The engine a block declared, from the label the catalog install stamps. */
  static engineOf(app: ApplicationEntity): string | null {
    return (
      (app.labels as Record<string, string> | undefined)?.[DB_ENGINE_LABEL] ??
      null
    );
  }

  async ensureAtGeneration(
    app: ApplicationEntity,
    engine: string | null | undefined,
    port?: number | null,
  ): Promise<string | null> {
    return this.ensure(app, engine, port, { patchLive: false });
  }

  async ensureOnExisting(
    app: ApplicationEntity,
    engine?: string | null,
  ): Promise<string | null> {
    return this.ensure(
      app,
      engine ?? BlockConnectionUrlService.engineOf(app),
      app.port,
      { patchLive: true },
    );
  }

  /**
   * Rewrite both addresses from the database's current pooler state and patch
   * the live Secret. Unlike `ensure`, an existing value does not win: this is
   * how the connection URL moves onto the pooler once the pooler is ready.
   * Consumers read the Secret at pod start, so they follow at their next start.
   */
  async recompose(app: ApplicationEntity): Promise<void> {
    const engine = BlockConnectionUrlService.engineOf(app);
    const urls = this.compose(app, engine, app.port);
    if (!urls) return;
    const values = this.valuesFor(engine, urls);
    await this.write(app, values);
    await this.patchLiveSecret(app, values);
    this.logger.log(
      `block ${app.slug}: ${Object.keys(values).join(', ')} recomposed` +
        `${BlockConnectionUrlService.pooledHost(app) ? ' through the pooler' : ''}`,
    );
  }

  /** The pooler's host once it carries the connection URL, else null. */
  static pooledHost(app: ApplicationEntity): string | null {
    return app.pooler?.enabled && app.pooler.routed ? poolerHostOf(app) : null;
  }

  private async ensure(
    app: ApplicationEntity,
    engine: string | null | undefined,
    port: number | null | undefined,
    opts: { patchLive: boolean },
  ): Promise<string | null> {
    const env = (app.env as ApplicationEnvVar[] | undefined) ?? [];
    const present = (key: string) => {
      const e = env.find((v) => v.name === key);
      return !!(e && !e.pending && e.value);
    };
    const wanted = [
      CONNECTION_URL_KEY,
      ...(engine === 'postgres' ? [DIRECT_URL_KEY] : []),
    ];
    const missing = wanted.filter((key) => !present(key));
    if (!missing.length) return CONNECTION_URL_KEY;

    const urls = this.compose(app, engine, port);
    if (!urls) {
      // Not a datastore, or an engine with no profile. `fromService: url` is
      // refused by name upstream; nothing is written here.
      return null;
    }
    const all = this.valuesFor(engine, urls);
    const values = Object.fromEntries(missing.map((key) => [key, all[key]]));
    await this.write(app, values);

    if (opts.patchLive) {
      await this.patchLiveSecret(app, values);
    }

    this.logger.log(
      `block ${app.slug}: ${missing.join(', ')} composed from the ${engine} profile` +
        `${opts.patchLive ? ' and patched into the live Secret' : ''}`,
    );
    return CONNECTION_URL_KEY;
  }

  private compose(
    app: ApplicationEntity,
    engine: string | null | undefined,
    port: number | null | undefined,
  ): { connection: string; direct: string } | null {
    const env = (app.env as ApplicationEnvVar[] | undefined) ?? [];
    return composeConnectionUrls({
      engine,
      host: BlockConnectionUrlService.hostOf(app),
      port: port ?? app.port,
      env: this.plaintextEnv(env),
      poolerHost: BlockConnectionUrlService.pooledHost(app),
    });
  }

  private valuesFor(
    engine: string | null | undefined,
    urls: { connection: string; direct: string },
  ): Record<string, string> {
    return {
      [CONNECTION_URL_KEY]: urls.connection,
      ...(engine === 'postgres' ? { [DIRECT_URL_KEY]: urls.direct } : {}),
    };
  }

  private async write(
    app: ApplicationEntity,
    values: Record<string, string>,
  ): Promise<void> {
    const env = (app.env as ApplicationEnvVar[] | undefined) ?? [];
    const next = [
      ...env.filter((e) => !(e.name in values)),
      ...Object.entries(values).map(
        ([name, url]): ApplicationEnvVar => ({
          name,
          value: this.encryption.encrypt(url),
          secret: true,
          source: 'link',
        }),
      ),
    ];
    await this.applicationsRepo.update(app.id, { env: next });
    app.env = next;
  }

  /**
   * Add the keys to the Secret that is already in the cluster.
   *
   * A failure here is not swallowed: a consumer wired to a `secretKeyRef` whose
   * key does not exist gets a pod that never starts, so the attach must fail
   * loudly now rather than green now and red in five minutes.
   */
  private async patchLiveSecret(
    app: ApplicationEntity,
    values: Record<string, string>,
  ): Promise<void> {
    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(
        `cluster ${app.clusterId} has no kubeconfig, so ${Object.keys(values).join(', ')} ` +
          `could not be added to the Secret of ${app.slug}`,
      );
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    await this.kubernetes.patchSecret(
      kubeconfig,
      app.k8sNamespace,
      `${app.slug}-secret`,
      values,
    );
  }

  /** The block's env with its secrets decrypted — never logged, never returned. */
  private plaintextEnv(env: ApplicationEnvVar[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of env) {
      if (e.pending) continue;
      if (e.externalSecretRef) continue;
      out[e.name] = e.secret ? this.decryptIfEncrypted(e.value) : e.value;
    }
    return out;
  }

  private decryptIfEncrypted(value: string): string {
    try {
      return this.encryption.decrypt(value);
    } catch {
      // Mirrors the manifest generator: a value marked secret but stored in
      // plaintext is used as-is rather than failing the whole attach.
      return value;
    }
  }
}
