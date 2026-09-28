import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  isControlClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { K3sUpgradeService } from './k3s-upgrade.service';
import { DeclaredImageService } from './declared-image.service';
import { PlatformUpgradeMetadata } from '../interfaces/platform-upgrade.interface';
import { SystemPort, kubernetesSystemPort } from '../utils/system-port.util';
import {
  API_CHECK,
  UpgradeCheck,
  apiDeploymentRef,
  apiImageCheck,
  deploymentChecks,
  nodesCheck,
  systemNamespaces,
} from '../utils/upgrade-checks.util';

/** The checks that close a platform update, read from every ready cluster. */
@Injectable()
export class PlatformUpgradeChecksService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly k3s: K3sUpgradeService,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly declaredImages: DeclaredImageService,
  ) {}

  async checks(metadata: PlatformUpgradeMetadata): Promise<UpgradeCheck[]> {
    const out: UpgradeCheck[] = [];
    const clusters = await this.clusterRepository.find({
      where: { status: ClusterStatus.READY },
    });
    const api = metadata.components.find((c) => c.key === 'fluiApi');
    const controlCluster = clusters.find(
      (c) => c.kubeconfigEncrypted && isControlClusterType(c.clusterType),
    );
    if (api && api.status !== 'skipped' && api.imageRef && controlCluster) {
      out.push(...(await this.apiChecks(api.imageRef, controlCluster)));
    }
    for (const cluster of clusters.filter((c) => c.kubeconfigEncrypted)) {
      const control = isControlClusterType(cluster.clusterType);
      try {
        const [plan] = await this.k3s.plan(
          cluster.id,
          metadata.k3sVersion ?? undefined,
        );
        out.push(nodesCheck(cluster.name, plan, metadata.k3sVersion));
        const deployments = await this.portOf(cluster).deployments(
          systemNamespaces(control),
        );
        out.push(...deploymentChecks(cluster.name, deployments));
      } catch (error) {
        out.push({
          name: `Cluster ${cluster.name}`,
          ok: false,
          detail: (error as Error).message,
        });
      }
    }
    return out;
  }

  private async apiChecks(
    imageRef: string,
    cluster: ClusterEntity,
  ): Promise<UpgradeCheck[]> {
    const ref = apiDeploymentRef();
    const out: UpgradeCheck[] = [];
    try {
      const deployment = await this.portOf(cluster).deployment(
        ref.namespace,
        ref.name,
      );
      out.push(apiImageCheck(ref, deployment, imageRef));
    } catch (error) {
      out.push({
        name: API_CHECK,
        ok: false,
        detail: (error as Error).message,
      });
    }
    const declared = await this.declaredImages.check(imageRef);
    out.push({
      name: 'API image declared on the control master',
      ok: declared.pinned,
      detail: declared.pinned ? undefined : declared.reason,
    });
    return out;
  }

  private portOf(cluster: ClusterEntity): SystemPort {
    return this.systemPort(
      this.encryptionService.decrypt(cluster.kubeconfigEncrypted as string),
    );
  }

  systemPort(kubeconfig: string): SystemPort {
    return kubernetesSystemPort(this.kubernetesService, kubeconfig);
  }
}
