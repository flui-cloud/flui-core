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
import {
  FLUI_NAMESPACE_LABEL_SELECTOR,
  KubernetesService,
} from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import {
  formatStorageBytes,
  parseStorageQuantityToBytes,
} from '../../../../common/utils/storage-quantity.util';
import {
  OrphanedClaimDto,
  OrphanedClaimsDto,
} from '../dto/orphaned-claims.dto';
import { isReservedNamespace } from '../../../applications/utils/reserved-namespace.util';

interface NamespaceScan {
  claims: any[];
  mounted: Set<string>;
  statefulSets: string[];
}

/**
 * How long a claim must have existed before this listing will call it
 * abandoned.
 *
 * The general form of the lesson `flui-system/postgres-data` taught: a volume
 * that has just appeared is far more likely to be one being created than one
 * left behind, and every check here reads a moment rather than a history. A
 * listing of abandoned storage has no urgency, so waiting costs nothing and
 * removes a whole class of race — an application whose claim exists before its
 * first pod is scheduled cannot be caught mid-birth.
 */
const SETTLING_WINDOW_MS = 15 * 60 * 1000;

/** Flui's own label on a claim it wrote itself. */
const OWNER_LABEL = 'flui-app-id';

/**
 * Where a chart writes the release it belongs to. Read as evidence, never as
 * proof on its own: a match only decides *which* application a claim belongs
 * to, after which that application's own state decides the answer.
 */
const INSTANCE_LABELS = ['app', 'app.kubernetes.io/instance'] as const;

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
 * data and the cost of a false negative is a volume left where it is. Nothing
 * is called abandoned unless ALL of these hold:
 *  - it lives in a namespace Flui made for applications — never the platform's
 *    own, never Kubernetes' own (`isReservedNamespace` is the same rule that
 *    refuses to *place* an application there);
 *  - no pod in that namespace mounts it (this alone spares Prometheus, Loki and
 *    every other running thing that Flui does not model as an application);
 *  - no live StatefulSet could have minted it from a `volumeClaimTemplate`;
 *  - nothing attributes it to an application that is still alive — not the
 *    `flui-app-id` label, not its name, not the chart labels a composed install
 *    leaves behind;
 *  - it has been there long enough to have settled ({@link SETTLING_WINDOW_MS}).
 *
 * On top of that it needs a positive reason to be called abandoned, and there
 * are four. The first two are Flui's own handwriting; the last two are the
 * widening decision 85 asked for, and each is argued from "this cannot be a
 * live volume", never from "this finds more":
 *
 *  - **Flui's label names an application that is gone.** Its writer said whose
 *    it was, and that application no longer exists.
 *  - **It is `<template>-<set>-<ordinal>` and no such StatefulSet exists.**
 *    Kubernetes mints exactly that name from a `volumeClaimTemplate`; with the
 *    set gone nothing can ever re-bind it.
 *  - **It is attributed by name to an application Flui deleted.** Every object
 *    an install creates is named after the application's slug, and slugs are
 *    unique installation-wide; the longest matching slug wins, so a live
 *    `redis-cache` is never mistaken for a deleted `redis`. This is the case
 *    the old rule missed entirely: a plain unlabelled claim from a third-party
 *    chart.
 *  - **Its namespace has no live application left at all.** These namespaces
 *    exist only because Flui created them to hold applications; with every one
 *    of them deleted, nothing there can be in use — and a namespace whose rows
 *    were removed outright (what the sandbox reaper does) is invisible to a
 *    scan driven by application rows alone, which is why the namespaces are
 *    also discovered from the cluster by Flui's own label.
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
    const namespaces = await this.namespacesToScan(kubeconfig, apps);
    const liveAppIds = new Set(
      apps.filter((a) => !a.deletedAt).map((a) => a.id),
    );
    const byId = new Map(apps.map((a) => [a.id, a]));
    const byNamespace = new Map<string, ApplicationEntity[]>();
    for (const app of apps) {
      if (!app.k8sNamespace) continue;
      const list = byNamespace.get(app.k8sNamespace) ?? [];
      list.push(app);
      byNamespace.set(app.k8sNamespace, list);
    }

    const claims: OrphanedClaimDto[] = [];
    for (const namespace of namespaces) {
      const scan = await this.scan(kubeconfig, namespace);
      for (const item of scan.claims) {
        const dto = this.judge(
          item,
          namespace,
          scan,
          liveAppIds,
          byId,
          byNamespace.get(namespace) ?? [],
        );
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

  /**
   * The namespaces this listing may look in.
   *
   * Two sources, because neither is complete on its own. The application rows
   * name the namespaces Flui has put work into — including ones whose
   * applications are all deleted, which is exactly where leftovers are. The
   * cluster names the rest: a tenancy the sandbox reaper took apart has its
   * rows *removed*, not marked, so its namespace appears in no row at all and a
   * scan driven by rows alone can never see what stayed behind.
   *
   * Both are then filtered by the same rule that decides where an application
   * may be placed. A reserved namespace cannot hold one
   * (`assertPlaceableNamespace` refuses), so nothing in it can be an
   * application's leftover — which is what keeps `flui-system/postgres-data`,
   * Flui's own database, out of a list with a delete button next to it, and
   * keeps it out by reason rather than by the accident of its name.
   */
  private async namespacesToScan(
    kubeconfig: string,
    apps: ApplicationEntity[],
  ): Promise<string[]> {
    const fromCluster = await this.fluiNamespaces(kubeconfig);
    const fromRows = apps
      .map((a) => a.k8sNamespace)
      .filter((n): n is string => !!n);
    return [...new Set([...fromRows, ...fromCluster])]
      .filter((ns) => !isReservedNamespace(ns))
      .sort((a, b) => a.localeCompare(b));
  }

  private async fluiNamespaces(kubeconfig: string): Promise<string[]> {
    try {
      const items = await this.kubernetesService.listNamespaces(
        kubeconfig,
        FLUI_NAMESPACE_LABEL_SELECTOR,
      );
      return items
        .map((n: any) => n?.metadata?.name as string)
        .filter((n): n is string => !!n);
    } catch (err) {
      this.logger.warn(
        `[ORPHAN] could not list namespaces: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Which application a claim belongs to, judged by name.
   *
   * Everything an install creates is named after the application's slug —
   * `<slug>`, `<slug>-<component>`, and `<volume>-<slug>-<component>-<ordinal>`
   * for anything a StatefulSet mints — and a chart repeats the same name in its
   * `app` labels. Slugs are unique across the installation, so the longest one
   * appearing as a whole dash-delimited run inside that evidence is the owner:
   * a claim of a live `redis-cache` can never be attributed to a deleted
   * `redis`, because the longer match wins.
   *
   * Deliberately scoped to the claim's own namespace. An application's objects
   * live in its namespace, and matching across namespaces would let a name
   * somewhere else decide the fate of a volume here.
   */
  private attribute(
    name: string,
    labels: Record<string, string>,
    namespaceApps: ApplicationEntity[],
  ): ApplicationEntity | undefined {
    const evidence = [name, ...INSTANCE_LABELS.map((l) => labels[l])]
      .filter((e): e is string => !!e)
      .map((e) => `-${e}-`);

    let best: ApplicationEntity | undefined;
    for (const app of namespaceApps) {
      if (!app.slug) continue;
      if (!evidence.some((e) => e.includes(`-${app.slug}-`))) continue;
      if (!best || app.slug.length > best.slug.length) best = app;
    }
    return best;
  }

  private judge(
    item: any,
    namespace: string,
    scan: NamespaceScan,
    liveAppIds: Set<string>,
    byId: Map<string, ApplicationEntity>,
    namespaceApps: ApplicationEntity[],
  ): OrphanedClaimDto | null {
    const name = item?.metadata?.name as string | undefined;
    if (!name) return null;
    if (scan.mounted.has(name)) return null;

    const labels = (item?.metadata?.labels ?? {}) as Record<string, string>;
    const owner = labels[OWNER_LABEL];
    if (owner && liveAppIds.has(owner)) return null;

    const attributed = this.attribute(name, labels, namespaceApps);
    if (attributed && !attributed.deletedAt) return null;

    const withoutOrdinal = /^(.*)-\d+$/.exec(name)?.[1];
    if (
      withoutOrdinal &&
      scan.statefulSets.some((set) => withoutOrdinal.endsWith(`-${set}`))
    ) {
      return null;
    }

    const createdAt = (item?.metadata?.creationTimestamp as string) ?? null;
    if (!this.hasSettled(createdAt)) return null;

    const emptyNamespace = !namespaceApps.some((a) => !a.deletedAt);
    const previous = owner ? byId.get(owner) : attributed;
    const reason = this.reasonFor({
      owner,
      previous,
      attributed,
      withoutOrdinal,
      emptyNamespace,
      namespace,
    });
    if (!reason) return null;

    const requested =
      (item?.spec?.resources?.requests?.storage as string | undefined) ?? null;
    return {
      name,
      namespace,
      requested,
      requestedBytes: parseStorageQuantityToBytes(requested),
      sizeLabel: formatStorageBytes(parseStorageQuantityToBytes(requested)),
      storageClass: (item?.spec?.storageClassName as string) ?? null,
      phase: (item?.status?.phase as string) ?? null,
      createdAt,
      lastKnownApplication: previous
        ? {
            id: previous.id,
            name: previous.name,
            deletedAt: previous.deletedAt
              ? new Date(previous.deletedAt).toISOString()
              : null,
          }
        : undefined,
      reason,
    };
  }

  /**
   * Why this one is abandoned, or null if nothing says it is. Written as the
   * sentence a person reads next to a delete button, so it names the evidence
   * rather than the rule number.
   */
  private reasonFor(f: {
    owner?: string;
    previous?: ApplicationEntity;
    attributed?: ApplicationEntity;
    withoutOrdinal?: string;
    emptyNamespace: boolean;
    namespace: string;
  }): string | null {
    if (f.owner) {
      return f.previous
        ? `its application "${f.previous.name}" was deleted and no pod mounts it`
        : 'it is labelled with an application that no longer exists, and no pod mounts it';
    }
    if (f.attributed) {
      return `it is named after "${f.attributed.name}", which was deleted, and no pod mounts it`;
    }
    if (f.withoutOrdinal) {
      return 'no application, no StatefulSet and no pod refers to it';
    }
    if (f.emptyNamespace) {
      return `every application in ${f.namespace} has been deleted, and no pod mounts it`;
    }
    return null;
  }

  private hasSettled(createdAt: string | null): boolean {
    if (!createdAt) return false;
    const age = Date.now() - new Date(createdAt).getTime();
    return Number.isFinite(age) && age >= SETTLING_WINDOW_MS;
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
