import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../shared/encryption/services/encryption.service';
import { projectNamespace } from '../applications/utils/k8s-namespace.util';

export const PROJECT_LABEL = 'flui.cloud/project';

/** Clusters that answer: a space on one that does not is caught at the next deploy. */
const REACHABLE = [ClusterStatus.READY, ClusterStatus.SCALING];

export interface ProjectSpacesRemoval {
  removed: string[];
  failed: Array<{ cluster: string; error: string }>;
}

/**
 * The spaces a project has on each cluster. Removed with the project, and only
 * when the space says it is that project's: a name alone could be anybody's.
 */
@Injectable()
export class ProjectSpacesService {
  private readonly logger = new Logger(ProjectSpacesService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async removeAll(project: {
    id: string;
    slug: string;
  }): Promise<ProjectSpacesRemoval> {
    const namespace = projectNamespace(project.slug);
    const clusters = await this.clusters.find({
      where: { status: In(REACHABLE) },
      select: ['id', 'name', 'kubeconfigEncrypted'],
    });
    const result: ProjectSpacesRemoval = { removed: [], failed: [] };
    for (const cluster of clusters) {
      if (!cluster.kubeconfigEncrypted) continue;
      try {
        const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
        const ns = await this.k8s.getResource(
          kubeconfig,
          'Namespace',
          namespace,
        );
        if (ns?.metadata?.labels?.[PROJECT_LABEL] !== project.id) continue;
        await this.k8s.deleteNamespace(kubeconfig, namespace);
        result.removed.push(cluster.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Space ${namespace} not removed from cluster ${cluster.name}: ${message}`,
        );
        result.failed.push({ cluster: cluster.name, error: message });
      }
    }
    return result;
  }
}
