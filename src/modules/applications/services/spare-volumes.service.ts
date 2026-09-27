import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { PREVIOUS_VOLUME_LABEL } from './statefulset-volume-swap.service';

const RESTORED_FROM_LABEL = 'flui.cloud/restored-from';

export interface SpareVolume {
  name: string;
  /** `restored`: a copy brought back and not put in use; `previous`: what the app used before a swap. */
  kind: 'restored' | 'previous';
  size: string | null;
  createdAt: string | null;
  inUse: boolean;
  restoredFrom: string | null;
}

/**
 * Volumes an application owns but does not run on: a copy restored beside it
 * and never put in use, and the data it ran on before a swap. They are full
 * volumes and are paid for as such, so they are listed where the copies are
 * and can be removed one by one; deleting the application removes them too.
 */
@Injectable()
export class SpareVolumesService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async list(appId: string): Promise<SpareVolume[]> {
    const { app, kubeconfig } = await this.context(appId);
    const claims = await this.k8s.listResourcesByLabel(
      kubeconfig,
      'PersistentVolumeClaim',
      app.k8sNamespace,
      `flui-app-id=${app.id}`,
    );
    const spare: SpareVolume[] = [];
    for (const claim of claims) {
      const kind = spareKindOf(claim?.metadata?.labels);
      if (!kind) continue;
      const name = claim.metadata.name as string;
      const mounting = await this.k8s.findPodsMountingPvc(
        kubeconfig,
        app.k8sNamespace,
        name,
      );
      spare.push({
        name,
        kind,
        size: claim.spec?.resources?.requests?.storage ?? null,
        createdAt: isoOf(claim.metadata?.creationTimestamp),
        inUse: mounting.length > 0,
        restoredFrom: claim.metadata?.labels?.[RESTORED_FROM_LABEL] ?? null,
      });
    }
    return spare.sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    );
  }

  async remove(appId: string, name: string): Promise<void> {
    const { app, kubeconfig } = await this.context(appId);
    const claim = await this.k8s.getResource(
      kubeconfig,
      'PersistentVolumeClaim',
      name,
      app.k8sNamespace,
    );
    if (
      !claim ||
      claim.metadata?.labels?.['flui-app-id'] !== app.id ||
      !spareKindOf(claim.metadata?.labels)
    ) {
      throw new NotFoundException(
        `${name} is not a restored or previous volume of this application`,
      );
    }
    const mounting = await this.k8s.findPodsMountingPvc(
      kubeconfig,
      app.k8sNamespace,
      name,
    );
    if (mounting.length) {
      throw new ConflictException(
        `${name} is in use by the application; it cannot be deleted`,
      );
    }
    await this.k8s.deleteResource(
      kubeconfig,
      'PersistentVolumeClaim',
      name,
      app.k8sNamespace,
    );
  }

  private async context(appId: string) {
    const app = await this.applications.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException('The application cluster is not reachable');
    }
    return {
      app,
      kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
    };
  }
}

export function spareKindOf(
  labels: Record<string, string> | undefined,
): SpareVolume['kind'] | null {
  if (labels?.[PREVIOUS_VOLUME_LABEL] === 'true') return 'previous';
  if (labels?.[RESTORED_FROM_LABEL]) return 'restored';
  return null;
}

/** The Kubernetes client hands timestamps back as Date objects. */
function isoOf(value: unknown): string | null {
  if (!value) return null;
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' || typeof value === 'number')
    date = new Date(String(value));
  else return null;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
