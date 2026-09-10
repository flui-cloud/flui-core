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
  composeConnectionUrl,
} from '../../attached-services/connection-url.core';

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

  private async ensure(
    app: ApplicationEntity,
    engine: string | null | undefined,
    port: number | null | undefined,
    opts: { patchLive: boolean },
  ): Promise<string | null> {
    const env = (app.env as ApplicationEnvVar[] | undefined) ?? [];
    const existing = env.find((e) => e.name === CONNECTION_URL_KEY);
    if (existing && !existing.pending && existing.value) {
      return CONNECTION_URL_KEY;
    }

    const url = composeConnectionUrl({
      engine,
      host: BlockConnectionUrlService.hostOf(app),
      port: port ?? app.port,
      env: this.plaintextEnv(env),
    });
    if (!url) {
      // Not a datastore, or an engine with no profile. `fromService: url` is
      // refused by name upstream; nothing is written here.
      return null;
    }

    const entry: ApplicationEnvVar = {
      name: CONNECTION_URL_KEY,
      value: this.encryption.encrypt(url),
      secret: true,
      source: 'link',
    };
    const next = [...env.filter((e) => e.name !== CONNECTION_URL_KEY), entry];
    await this.applicationsRepo.update(app.id, { env: next });
    app.env = next;

    if (opts.patchLive) {
      await this.patchLiveSecret(app, url);
    }

    this.logger.log(
      `block ${app.slug}: ${CONNECTION_URL_KEY} composed from the ${engine} profile` +
        `${opts.patchLive ? ' and patched into the live Secret' : ''}`,
    );
    return CONNECTION_URL_KEY;
  }

  /**
   * Add the key to the Secret that is already in the cluster.
   *
   * A failure here is not swallowed: a consumer wired to a `secretKeyRef` whose
   * key does not exist gets a pod that never starts, so the attach must fail
   * loudly now rather than green now and red in five minutes.
   */
  private async patchLiveSecret(
    app: ApplicationEntity,
    url: string,
  ): Promise<void> {
    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(
        `cluster ${app.clusterId} has no kubeconfig, so ${CONNECTION_URL_KEY} ` +
          `could not be added to the Secret of ${app.slug}`,
      );
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    await this.kubernetes.patchSecret(
      kubeconfig,
      app.k8sNamespace,
      `${app.slug}-secret`,
      { [CONNECTION_URL_KEY]: url },
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
