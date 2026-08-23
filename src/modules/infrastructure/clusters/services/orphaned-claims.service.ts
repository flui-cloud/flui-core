import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import {
  formatStorageBytes,
  parseStorageQuantityToBytes,
} from '../../../../common/utils/storage-quantity.util';
import {
  OrphanedClaimDto,
  OrphanedClaimsDto,
} from '../dto/orphaned-claims.dto';

interface NamespaceScan {
  claims: any[];
  mounted: Set<string>;
  statefulSets: string[];
}

/**
 * The volumes of applications that no longer exist.
 *
 * Repairing forward does not clean up the past: the
 * instances running today hold claims whose applications were removed before
 * the teardown learned to take them, and nothing ever lists them, so nobody
 * knows they are there. This is the listing. Removing one is a separate call,
 * and it re-runs this whole check before it touches anything — seen and
 * counted first, touched only after.
 *
 * Deliberately conservative, because the cost of a false positive is somebody's
 * data. A claim is abandoned only when ALL of these hold:
 *  - it lives in a namespace Flui puts applications in — never `kube-system`,
 *    never the platform's own;
 *  - no pod in that namespace mounts it (this alone spares Prometheus, Loki and
 *    every other running thing that Flui does not model as an application);
 *  - no live StatefulSet could have minted it from a `volumeClaimTemplate`;
 *  - it does not name a live application in `flui-app-id`.
 */
@Injectable()
export class OrphanedClaimsService {
  private readonly logger = new Logger(OrphanedClaimsService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async list(clusterId: string): Promise<OrphanedClaimsDto> {
    const { kubeconfig, note } = await this.kubeconfigFor(clusterId);
    const empty: OrphanedClaimsDto = {
      clusterId,
      namespacesScanned: [],
      claims: [],
      totalBytes: 0,
      totalLabel: formatStorageBytes(0),
    };
    if (!kubeconfig) return { ...empty, note };

    // `deletedAt` is an ordinary column here, not TypeORM's soft-delete one, so
    // a plain find already returns the removed applications — which is the
    // half that matters: their namespaces are where the leftovers are.
    const apps = await this.applications.find({ where: { clusterId } });
    const namespaces = [
      ...new Set(
        apps.map((a) => a.k8sNamespace).filter((n): n is string => !!n),
      ),
    ].sort((a, b) => a.localeCompare(b));
    const liveAppIds = new Set(
      apps.filter((a) => !a.deletedAt).map((a) => a.id),
    );
    const byId = new Map(apps.map((a) => [a.id, a]));

    const claims: OrphanedClaimDto[] = [];
    for (const namespace of namespaces) {
      const scan = await this.scan(kubeconfig, namespace);
      for (const item of scan.claims) {
        const dto = this.judge(item, namespace, scan, liveAppIds, byId);
        if (dto) claims.push(dto);
      }
    }

    const totalBytes = claims.reduce((sum, c) => sum + c.requestedBytes, 0);
    return {
      clusterId,
      namespacesScanned: namespaces,
      claims,
      totalBytes,
      totalLabel: formatStorageBytes(totalBytes),
    };
  }

  /**
   * Remove one claim, and only if it is still abandoned when asked again. The
   * listing a person read may be minutes old; between then and now a pod could
   * have mounted it or an application could have been recreated over it.
   */
  async remove(
    clusterId: string,
    namespace: string,
    name: string,
  ): Promise<{ removed: true; freed: string; freedBytes: number }> {
    const current = await this.list(clusterId);
    const claim = current.claims.find(
      (c) => c.namespace === namespace && c.name === name,
    );
    if (!claim) {
      throw new BadRequestException(
        `${namespace}/${name} is not an abandoned volume on this cluster — ` +
          'it is in use, it belongs to an application that still exists, or it ' +
          'does not exist. Nothing was deleted.',
      );
    }

    const { kubeconfig } = await this.kubeconfigFor(clusterId);
    if (!kubeconfig) {
      throw new BadRequestException('The cluster is not reachable from here.');
    }
    await this.kubernetesService.deleteResource(
      kubeconfig,
      'PersistentVolumeClaim',
      name,
      namespace,
    );
    this.logger.log(
      `[ORPHAN] removed abandoned claim ${namespace}/${name} (${claim.sizeLabel}) on cluster ${clusterId}`,
    );
    return {
      removed: true,
      freed: claim.sizeLabel,
      freedBytes: claim.requestedBytes,
    };
  }

  private judge(
    item: any,
    namespace: string,
    scan: NamespaceScan,
    liveAppIds: Set<string>,
    byId: Map<string, ApplicationEntity>,
  ): OrphanedClaimDto | null {
    const name = item?.metadata?.name as string | undefined;
    if (!name) return null;
    if (scan.mounted.has(name)) return null;

    const owner = item?.metadata?.labels?.['flui-app-id'] as string | undefined;
    if (owner && liveAppIds.has(owner)) return null;

    const withoutOrdinal = /^(.*)-\d+$/.exec(name)?.[1];
    if (
      withoutOrdinal &&
      scan.statefulSets.some((set) => withoutOrdinal.endsWith(`-${set}`))
    ) {
      return null;
    }

    // Two shapes and no third. Flui labels every claim it writes itself, and
    // Kubernetes names every claim a `volumeClaimTemplate` makes
    // `<template>-<set>-<ordinal>` — between them that is the whole population
    // an application teardown can leave behind. Anything else in these
    // namespaces belongs to the platform: `flui-system/postgres-data` is Flui's
    // own database, and it is unmounted for the seconds its pod takes to
    // restart. Calling that abandoned once would be enough.
    if (!owner && !withoutOrdinal) return null;

    const requested =
      (item?.spec?.resources?.requests?.storage as string | undefined) ?? null;
    const previous = owner ? byId.get(owner) : undefined;
    return {
      name,
      namespace,
      requested,
      requestedBytes: parseStorageQuantityToBytes(requested),
      sizeLabel: formatStorageBytes(parseStorageQuantityToBytes(requested)),
      storageClass: (item?.spec?.storageClassName as string) ?? null,
      phase: (item?.status?.phase as string) ?? null,
      createdAt: (item?.metadata?.creationTimestamp as string) ?? null,
      lastKnownApplication: previous
        ? {
            id: previous.id,
            name: previous.name,
            deletedAt: previous.deletedAt
              ? new Date(previous.deletedAt).toISOString()
              : null,
          }
        : undefined,
      reason: previous
        ? `its application "${previous.name}" was deleted and no pod mounts it`
        : 'no application, no StatefulSet and no pod refers to it',
    };
  }

  private async scan(
    kubeconfig: string,
    namespace: string,
  ): Promise<NamespaceScan> {
    const [claims, pods, sets] = await Promise.all([
      this.list_(kubeconfig, 'PersistentVolumeClaim', namespace),
      this.list_(kubeconfig, 'Pod', namespace),
      this.list_(kubeconfig, 'StatefulSet', namespace),
    ]);

    const mounted = new Set<string>();
    for (const pod of pods) {
      for (const volume of (pod?.spec?.volumes ?? []) as any[]) {
        const claimName = volume?.persistentVolumeClaim?.claimName as
          | string
          | undefined;
        if (claimName) mounted.add(claimName);
      }
    }

    return {
      claims,
      mounted,
      statefulSets: sets
        .map((s: any) => s?.metadata?.name as string)
        .filter((n): n is string => !!n),
    };
  }

  private async list_(
    kubeconfig: string,
    kind: string,
    namespace: string,
  ): Promise<any[]> {
    try {
      return await this.kubernetesService.listResourcesByLabel(
        kubeconfig,
        kind,
        namespace,
        '',
      );
    } catch (err) {
      this.logger.warn(
        `[ORPHAN] could not list ${kind} in ${namespace}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private async kubeconfigFor(
    clusterId: string,
  ): Promise<{ kubeconfig: string | null; note?: string }> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (!cluster.kubeconfigEncrypted) {
      return {
        kubeconfig: null,
        note: 'The cluster has no kubeconfig on file, so nothing could be scanned. An empty list here does not mean there is nothing to find.',
      };
    }
    try {
      return {
        kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
      };
    } catch (err) {
      this.logger.warn(
        `[ORPHAN] kubeconfig for cluster ${clusterId} could not be read: ${(err as Error).message}`,
      );
      return {
        kubeconfig: null,
        note: 'The cluster credentials could not be read, so nothing could be scanned.',
      };
    }
  }
}
