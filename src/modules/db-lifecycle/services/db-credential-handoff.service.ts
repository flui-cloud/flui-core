import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BlockConnectionUrlService } from '../../catalog/services/block-connection-url.service';
import {
  CONNECTION_URL_KEY,
  DIRECT_URL_KEY,
} from '../../attached-services/connection-url.core';
import type { PoolerSpec } from '../../applications/utils/db-pooler.core';

export const SOURCE_CREDENTIAL_ENV = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
] as const;
export const STANDBY_ENV = 'FLUI_PG_STANDBY';

/**
 * After promote the destination's data directory carries the source's roles
 * and passwords. Its stored env is brought in line, so a redeploy or a
 * consumer reads credentials that work, and the entrypoint never changes a
 * password the data already has. The live Secret is patched, no restart.
 */
@Injectable()
export class DbCredentialHandoffService {
  private readonly logger = new Logger(DbCredentialHandoffService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
    private readonly k8s: KubernetesService,
    private readonly connectionUrl: BlockConnectionUrlService,
  ) {}

  async adoptSourceCredentials(
    srcAppId: string,
    dstAppId: string,
  ): Promise<void> {
    await this.adopt(srcAppId, dstAppId, { keepStandby: false });
  }

  /**
   * Before promote, for a destination whose consumers already read its Secret
   * while it is a standby: the source's credentials and both URLs recomposed,
   * the standby switch kept. The standby never runs initdb, so it never reads
   * `POSTGRES_PASSWORD`.
   */
  async adoptSourceIdentity(srcAppId: string, dstAppId: string): Promise<void> {
    await this.adopt(srcAppId, dstAppId, { keepStandby: true });
  }

  /**
   * A physical copy carries the source's pooler role and password, so the
   * destination's pooler logs in with the source's. Routed like the source's:
   * the connection URL goes through the pooler when the source's did. False
   * when either side has no pooler.
   */
  async adoptSourcePoolerAuth(
    srcAppId: string,
    dstAppId: string,
  ): Promise<boolean> {
    const { src, dst } = await this.pair(srcAppId, dstAppId);
    if (!src.pooler?.enabled || !dst.pooler?.enabled) return false;
    const pooler: PoolerSpec = {
      ...dst.pooler,
      authPasswordEnc: src.pooler.authPasswordEnc,
      adminPasswordEnc: src.pooler.adminPasswordEnc,
      routed: !!src.pooler.routed,
      lastError: null,
    };
    await this.apps.update(dst.id, { pooler } as never);
    this.logger.log(
      `[db-phys] the pooler of ${dst.slug} now logs in like the pooler of ${src.slug}`,
    );
    return true;
  }

  private async adopt(
    srcAppId: string,
    dstAppId: string,
    opts: { keepStandby: boolean },
  ): Promise<void> {
    const { src, dst } = await this.pair(srcAppId, dstAppId);
    const next = adoptCredentials(src.env ?? [], dst.env ?? [], opts);
    await this.apps.update(dst.id, { env: next });
    dst.env = next;

    const live: Record<string, string> = {};
    for (const e of next) {
      if (
        e.secret &&
        (SOURCE_CREDENTIAL_ENV as readonly string[]).includes(e.name)
      ) {
        live[e.name] = this.plain(e.value);
      }
    }
    if (Object.keys(live).length) {
      const cluster = await this.clusters.findOne({
        where: { id: dst.clusterId },
      });
      if (cluster?.kubeconfigEncrypted) {
        await this.k8s.patchSecret(
          this.encryption.decrypt(cluster.kubeconfigEncrypted),
          dst.k8sNamespace,
          `${dst.slug}-secret`,
          live,
        );
      }
    }
    await this.connectionUrl.ensureOnExisting(dst);
    this.logger.log(
      `[db-phys] ${dst.slug} now carries the credentials of ${src.slug}`,
    );
  }

  private async pair(
    srcAppId: string,
    dstAppId: string,
  ): Promise<{ src: ApplicationEntity; dst: ApplicationEntity }> {
    const src = await this.apps.findOne({ where: { id: srcAppId } });
    const dst = await this.apps.findOne({ where: { id: dstAppId } });
    if (!src || !dst) {
      throw new NotFoundException('Source or destination database is gone');
    }
    return { src, dst };
  }

  private plain(value: string): string {
    try {
      return this.encryption.decrypt(value);
    } catch {
      return value;
    }
  }
}

/**
 * The destination's env with the source's credentials, the standby switch
 * cleared unless kept, and the stale connection URLs dropped so they are composed again.
 */
export function adoptCredentials(
  srcEnv: ApplicationEnvVar[],
  dstEnv: ApplicationEnvVar[],
  opts: { keepStandby?: boolean } = {},
): ApplicationEnvVar[] {
  const fromSource = new Map(
    srcEnv
      .filter((e) =>
        (SOURCE_CREDENTIAL_ENV as readonly string[]).includes(e.name),
      )
      .map((e) => [e.name, e]),
  );
  const out = dstEnv
    .filter((e) => e.name !== CONNECTION_URL_KEY && e.name !== DIRECT_URL_KEY)
    .map((e) => {
      const s = fromSource.get(e.name);
      if (s) return { ...e, value: s.value, secret: s.secret };
      if (e.name === STANDBY_ENV && !opts.keepStandby) {
        return { ...e, value: '' };
      }
      return e;
    });
  for (const [name, s] of fromSource) {
    if (!out.some((e) => e.name === name)) out.push({ ...s });
  }
  return out;
}
