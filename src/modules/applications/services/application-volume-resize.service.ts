import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import {
  ApplicationVolumeClaimsService,
  ApplicationVolumeClaim,
} from './application-volume-claims.service';
import { parseStorageQuantityToBytes } from '../../../common/utils/storage-quantity.util';

const GIB = 1024 * 1024 * 1024;

const RESIZE_MESSAGE: Record<string, string> = {
  applied: 'The volume is bigger and the extra space is usable now.',
  'restart-required':
    'The volume is bigger, but the filesystem inside it only grows when the application restarts.',
  'in-progress':
    'The new size was accepted and the storage is working on it. Check again in a moment — if it never changes, this storage cannot actually grow a volume.',
};

export interface VolumeResizePlan {
  volumeName: string;
  namespace: string;
  storageClass: string | null;
  current: string | null;
  currentBytes: number;
  canGrow: boolean;
  reason?: string;
}

/**
 * `applied` — the storage reports the new size and it is usable now.
 * `restart-required` — the disk grew, the filesystem inside it has not.
 * `in-progress` — the request was accepted and nothing has happened yet.
 */
export type VolumeResizeOutcome =
  | 'applied'
  | 'restart-required'
  | 'in-progress';

export interface VolumeResizeResult {
  volumeName: string;
  namespace: string;
  from: string | null;
  to: string;
  outcome: VolumeResizeOutcome;
  restartRequired: boolean;
  message: string;
}

/**
 * Growing one application's volume.
 *
 * The honest shape of this feature is a refusal on most clusters, and that is
 * deliberate. Flui's two default storage classes are both local-path
 * provisioners — the dedicated `flui.cloud/local-path` and the shared
 * `rancher.io/local-path` — and neither declares `allowVolumeExpansion`, so
 * Kubernetes will not accept a resize against them at all. Worse, local-path
 * never enforced the size in the first place: a claim of 1Mi was measured
 * taking 50MiB without complaint, the claim still reporting 1Mi. So on those
 * classes "grow my volume" is not merely unsupported, it is meaningless, and
 * telling somebody it worked would be the worst available answer.
 *
 * It becomes real the moment a cluster has a CSI class whose volumes are
 * provider block devices. Nothing here names a provider: the question asked is
 * always "does this claim's class allow expansion", which is the only thing
 * that decides the answer and which every CSI driver answers for itself.
 */
@Injectable()
export class ApplicationVolumeResizeService {
  private readonly logger = new Logger(ApplicationVolumeResizeService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly volumeClaims: ApplicationVolumeClaimsService,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * What could be done to each of this application's volumes, without doing
   * any of it. The dashboard needs this to decide whether to offer the control
   * at all, and the CLI needs it to explain a "no" before somebody types a size.
   */
  async planForApplication(applicationId: string): Promise<VolumeResizePlan[]> {
    const { app, kubeconfig } = await this.resolveAppContext(applicationId);
    const claims = await this.claimsOf(kubeconfig, app);
    const expandable = await this.expansionByClass(kubeconfig);
    return claims.map((claim) => this.planFor(claim, expandable));
  }

  /**
   * Grow one volume, or explain why it cannot grow.
   *
   * Kubernetes refuses to shrink a claim, so the only direction offered is up —
   * and that is checked here too, because the API's own error for it is a
   * validation message about a resource quantity rather than a sentence about
   * somebody's data.
   */
  async resize(
    applicationId: string,
    volumeName: string,
    targetSizeGb: number,
  ): Promise<VolumeResizeResult> {
    if (!Number.isFinite(targetSizeGb) || targetSizeGb <= 0) {
      throw new BadRequestException(
        'The new size must be a positive number of GiB.',
      );
    }

    const { app, kubeconfig } = await this.resolveAppContext(applicationId);
    const claims = await this.claimsOf(kubeconfig, app);

    const claim = claims.find((c) => c.name === volumeName);
    if (!claim) {
      throw new NotFoundException(
        `This application has no volume named "${volumeName}".`,
      );
    }

    const expandable = await this.expansionByClass(kubeconfig);
    const plan = this.planFor(claim, expandable);
    if (!plan.canGrow) {
      throw new BadRequestException(plan.reason);
    }

    // Measured against the API server: "spec is immutable after creation
    // except resources.requests ... for bound claims". Without this the caller
    // got a 500 for a volume that simply has not been used yet.
    if (claim.phase !== 'Bound') {
      throw new BadRequestException(
        `This volume is not in use yet (it is ${claim.phase ?? 'not ready'}), and a volume can only be resized once the application has started using it.`,
      );
    }

    if (targetSizeGb * GIB <= claim.requestedBytes) {
      throw new BadRequestException(
        `This volume already asks for ${claim.requested ?? 'an unknown size'}. A volume can only grow, never shrink.`,
      );
    }

    await this.patchRequestedSize(
      kubeconfig,
      claim.namespace,
      claim.name,
      `${targetSizeGb}Gi`,
    );

    const outcome = await this.observe(
      kubeconfig,
      claim.namespace,
      claim.name,
      targetSizeGb * GIB,
    );

    this.logger.log(
      `Volume ${claim.namespace}/${claim.name} of application ${app.slug} asked to grow from ${claim.requested ?? '?'} to ${targetSizeGb}Gi (${outcome})`,
    );

    return {
      volumeName: claim.name,
      namespace: claim.namespace,
      from: claim.requested,
      to: `${targetSizeGb}Gi`,
      outcome,
      restartRequired: outcome === 'restart-required',
      message: RESIZE_MESSAGE[outcome],
    };
  }

  private planFor(
    claim: ApplicationVolumeClaim,
    expandable: Map<string, boolean>,
  ): VolumeResizePlan {
    const base = {
      volumeName: claim.name,
      namespace: claim.namespace,
      storageClass: claim.storageClass,
      current: claim.requested,
      currentBytes: claim.requestedBytes,
    };

    if (!claim.storageClass) {
      return {
        ...base,
        canGrow: false,
        reason:
          'This volume was not created from a storage class, so its size cannot be changed.',
      };
    }

    const allows = expandable.get(claim.storageClass);
    if (allows === undefined) {
      return {
        ...base,
        canGrow: false,
        reason: `The storage class "${claim.storageClass}" no longer exists on this cluster, so its volumes cannot be changed.`,
      };
    }

    if (!allows) {
      return {
        ...base,
        canGrow: false,
        // Said plainly on purpose: on these classes the declared size is not a
        // ceiling either, so somebody asking to grow one is solving a problem
        // they do not have. What actually runs out is the space under the whole
        // cluster, and that is a different command.
        reason:
          `Volumes on "${claim.storageClass}" cannot be resized, because this storage keeps data in a folder on the machine rather than on a disk of its own. ` +
          'The size written on the volume is not a limit there — what runs out is the space on the cluster, which grows with the cluster storage instead.',
      };
    }

    return { ...base, canGrow: true };
  }

  private async claimsOf(
    kubeconfig: string,
    app: { id: string; slug: string; k8sNamespace: string },
  ): Promise<ApplicationVolumeClaim[]> {
    const tracked = await this.appResourcesRepository
      .findByApplicationId(app.id)
      .catch(() => []);
    return this.volumeClaims.resolveForApplication(kubeconfig, app, tracked, {
      excludeCopies: true,
    });
  }

  /**
   * Which storage classes on this cluster accept a resize.
   *
   * Read once per request rather than per volume: an application with four
   * components asks about four claims that almost always share one class.
   */
  private async expansionByClass(
    kubeconfig: string,
  ): Promise<Map<string, boolean>> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);
    const list = await storageApi.listStorageClass();

    const byName = new Map<string, boolean>();
    for (const item of list.items ?? []) {
      const name = item.metadata?.name;
      if (name) byName.set(name, item.allowVolumeExpansion === true);
    }
    return byName;
  }

  private async patchRequestedSize(
    kubeconfig: string,
    namespace: string,
    name: string,
    size: string,
  ): Promise<void> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);
    const patch = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name, namespace },
      spec: { resources: { requests: { storage: size } } },
    } as k8s.KubernetesObject;

    await client.patch(
      patch,
      undefined,
      undefined,
      'flui-api',
      undefined,
      k8s.PatchStrategy.MergePatch,
    );
  }

  /**
   * What actually happened, read back from the claim.
   *
   * Accepting the request is not the same as growing the volume, and the
   * difference was measured: a class that merely *declares*
   * `allowVolumeExpansion` gets the new number written into `spec` while
   * `status.capacity` stays where it was forever, because the provisioner
   * behind it has no resize controller at all. Reporting success from the
   * absence of a "pending" condition therefore told somebody their volume had
   * grown when nothing had, which is the one outcome this whole feature exists
   * to avoid. So the capacity is what is trusted, and anything short of it is
   * reported as still in progress rather than as done.
   */
  private async observe(
    kubeconfig: string,
    namespace: string,
    name: string,
    targetBytes: number,
  ): Promise<VolumeResizeOutcome> {
    try {
      const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const pvc = await coreApi.readNamespacedPersistentVolumeClaim({
        name,
        namespace,
      });

      const conditions = pvc.status?.conditions ?? [];
      if (
        conditions.some(
          (c) => c.type === 'FileSystemResizePending' && c.status === 'True',
        )
      ) {
        return 'restart-required';
      }

      const capacity = parseStorageQuantityToBytes(
        (pvc.status?.capacity?.storage as string | undefined) ?? null,
      );
      return capacity >= targetBytes ? 'applied' : 'in-progress';
    } catch {
      // The patch itself already succeeded; failing to read the claim back
      // must not turn that into an error for the caller.
      return 'in-progress';
    }
  }

  private async resolveAppContext(applicationId: string): Promise<{
    app: { id: string; slug: string; k8sNamespace: string };
    kubeconfig: string;
  }> {
    const app = await this.applicationsRepository.findById(applicationId);
    if (!app) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }
    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} for application ${applicationId} not found`,
      );
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.id} has no kubeconfig — cannot resize a volume`,
      );
    }
    return {
      app: { id: app.id, slug: app.slug, k8sNamespace: app.k8sNamespace },
      kubeconfig: this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
    };
  }
}
