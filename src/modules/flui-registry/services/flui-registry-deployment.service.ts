import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  isControlClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  FLUI_REGISTRY_CONFIG,
  FLUI_REGISTRY_NAME,
  FLUI_REGISTRY_NAMESPACE,
  FluiRegistryConfig,
} from '../flui-registry.config';
import {
  REGISTRY_ROLE_LABEL,
  renderRegistryManifests,
} from '../registry-manifest';
import { RegistrySigningKeyService } from './registry-signing-key.service';
import { RegistryStorageService } from './registry-storage.service';

/**
 * Puts the registry on the control cluster when the instance asks for one,
 * and keeps it trusting the API's current key. Nothing is created while
 * `FLUI_IMAGE_REGISTRY` is not `flui`.
 */
@Injectable()
export class FluiRegistryDeploymentService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FluiRegistryDeploymentService.name);

  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly keys: RegistrySigningKeyService,
    private readonly storage: RegistryStorageService,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.mode !== 'flui') return;
    this.reconcile().catch((error: unknown) =>
      this.logger.error(
        `The instance registry could not be put in place: ${messageOf(error)}`,
      ),
    );
  }

  async reconcile(): Promise<boolean> {
    if (this.config.mode !== 'flui') return false;
    if (!this.config.host) {
      throw new Error(
        'FLUI_IMAGE_REGISTRY=flui needs PUBLIC_API_URL or FLUI_REGISTRY_HOST to know where the registry answers',
      );
    }
    const control = await this.controlCluster();
    const objectStorage =
      this.config.storageBackend === 's3'
        ? await this.storage.connected()
        : undefined;
    if (this.config.storageBackend === 's3' && !objectStorage) {
      throw new Error(
        'FLUI_REGISTRY_STORAGE_BACKEND=s3 needs a bucket: connect one first',
      );
    }
    const kubeconfig = this.encryption.decrypt(control.kubeconfigEncrypted);
    const apiRoute = await this.kubernetes.readObject(
      kubeconfig,
      'traefik.io/v1alpha1',
      'IngressRoute',
      'flui-api',
      'flui-system',
    );
    await this.replaceOutdatedSelector(kubeconfig);
    await this.kubernetes.applyManifest(
      kubeconfig,
      renderRegistryManifests({
        config: this.config,
        host: this.config.host,
        publicKeyPem: await this.keys.publicKeyPem(),
        tls: (apiRoute?.spec?.tls as Record<string, unknown>) ?? {},
        objectStorage: objectStorage ?? undefined,
      }),
    );
    this.logger.log(
      `Instance registry in place on ${control.name}, answering on ${this.config.host}/v2`,
    );
    return true;
  }

  /**
   * Whether every copy of the registry runs its current configuration. Until
   * then some still read the bucket it was on before.
   */
  async settled(): Promise<boolean> {
    const control = await this.controlCluster();
    const kubeconfig = this.encryption.decrypt(control.kubeconfigEncrypted);
    const names =
      this.config.storageBackend === 's3'
        ? [FLUI_REGISTRY_NAME, `${FLUI_REGISTRY_NAME}-maintenance`]
        : [FLUI_REGISTRY_NAME];
    for (const name of names) {
      const deployment = await this.kubernetes.readObject(
        kubeconfig,
        'apps/v1',
        'Deployment',
        name,
        FLUI_REGISTRY_NAMESPACE,
      );
      const wanted = deployment?.spec?.replicas ?? 1;
      const status = deployment?.status ?? {};
      const current =
        deployment &&
        (status.observedGeneration ?? 0) >=
          (deployment.metadata?.generation ?? 0) &&
        status.updatedReplicas === wanted &&
        status.readyReplicas === wanted &&
        status.replicas === wanted;
      if (!current) return false;
    }
    return true;
  }

  private async controlCluster() {
    const control = (
      await this.clusters.find({ where: { status: ClusterStatus.READY } })
    ).find((c) => c.kubeconfigEncrypted && isControlClusterType(c.clusterType));
    if (!control) {
      throw new Error('No ready control cluster to run the registry on');
    }
    return control;
  }

  /**
   * A Deployment's selector cannot change in place. One created before copies
   * had roles selects on `app` alone, and is replaced rather than patched.
   */
  private async replaceOutdatedSelector(kubeconfig: string): Promise<void> {
    const current = await this.kubernetes.readObject(
      kubeconfig,
      'apps/v1',
      'Deployment',
      FLUI_REGISTRY_NAME,
      FLUI_REGISTRY_NAMESPACE,
    );
    const selector = current?.spec?.selector?.matchLabels ?? {};
    if (current && !selector[REGISTRY_ROLE_LABEL]) {
      await this.kubernetes.deleteObject(
        kubeconfig,
        'apps/v1',
        'Deployment',
        FLUI_REGISTRY_NAME,
        FLUI_REGISTRY_NAMESPACE,
      );
      this.logger.log('Replaced the registry Deployment created before roles');
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
