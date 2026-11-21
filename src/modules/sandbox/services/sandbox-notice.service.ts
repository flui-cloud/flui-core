import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { fluiAuthzImage } from '../../authz/constants/flui-authz-image';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { SANDBOX_CLUSTER_GONE } from './sandbox-capacity.service';
import {
  NOTICE_KEY_SECRET,
  NOTICE_NAMESPACE,
  buildNoticeDeployment,
  buildNoticeKeySecret,
  buildNoticeMiddleware,
  buildNoticeService,
} from '../constants/sandbox-notice.manifest';

/**
 * Keeps the trial notice on the sandbox cluster: the component that answers
 * Traefik for every guest app, and the middleware in every area that sends
 * the guest apps through it.
 *
 * The key that signs a visit is made on the cluster the first time and never
 * leaves it, so it is only ever as exposed as the cluster itself.
 */
@Injectable()
export class SandboxNoticeService {
  private readonly logger = new Logger(SandboxNoticeService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  async ensure(): Promise<void> {
    const kubeconfig = await this.kubeconfig();
    if (!kubeconfig) return;
    await this.ensureComponent(kubeconfig);

    const areas = await this.tenants.find({
      where: {
        clusterId: this.config.clusterId!,
        state: In([SandboxTenantState.READY, SandboxTenantState.CLAIMED]),
      },
      select: ['namespace'],
    });
    for (const { namespace } of areas) {
      await this.applyTo(kubeconfig, namespace).catch((error) =>
        this.logger.warn(
          `Trial notice middleware not applied in ${namespace}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  async ensureComponent(kubeconfig: string): Promise<void> {
    await this.k8s.ensureNamespaceExists(kubeconfig, NOTICE_NAMESPACE, {
      'managed-by': 'flui-cloud',
    });
    const secret = await this.k8s.getResource(
      kubeconfig,
      'Secret',
      NOTICE_KEY_SECRET,
      NOTICE_NAMESPACE,
    );
    if (!secret) {
      await this.k8s.applyManifest(
        kubeconfig,
        buildNoticeKeySecret(randomBytes(48).toString('base64url')),
      );
      this.logger.log('Made the trial notice key on the sandbox cluster');
    }
    await this.k8s.applyManifest(kubeconfig, buildNoticeService());
    await this.k8s.applyManifest(
      kubeconfig,
      buildNoticeDeployment(
        fluiAuthzImage(),
        this.config.notice,
        this.config.allowMasterPlacement,
      ),
    );
  }

  async applyTo(kubeconfig: string, namespace: string): Promise<void> {
    await this.k8s.applyManifest(kubeconfig, buildNoticeMiddleware(namespace));
  }

  private async kubeconfig(): Promise<string | null> {
    if (!this.config.clusterId) return null;
    const cluster = await this.clusters.findOne({
      where: {
        id: this.config.clusterId,
        status: Not(In(SANDBOX_CLUSTER_GONE)),
      },
    });
    if (!cluster?.kubeconfigEncrypted) return null;
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}
