import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { ApplicationEntity } from '../entities/application.entity';
import { parseStorageQuantityToBytes } from '../../../common/utils/storage-quantity.util';

/**
 * The mark `VolumeExportService` puts on a clone it creates. A clone carries
 * the application's own `flui-app-id` too — deliberately, so teardown sweeps it
 * — which would otherwise make it indistinguishable from a real volume of the
 * application and turn "back up this app's volume" into an ambiguous choice
 * the moment somebody took a snapshot.
 */
const PVC_CLONE_MARKER = 'flui.cloud/pvc-clone-export';
const PREVIOUS_VOLUME_MARKER = 'flui.cloud/previous-volume';
const RESTORED_FROM_MARKER = 'flui.cloud/restored-from';

export type ClaimAttribution =
  | 'label'
  | 'tracked-resource'
  | 'volume-claim-template';

export interface ApplicationVolumeClaim {
  name: string;
  namespace: string;
  requested: string | null;
  requestedBytes: number;
  storageClass: string | null;
  phase: string | null;
  attributedBy: ClaimAttribution;
}

type ClaimOwner = Pick<ApplicationEntity, 'id' | 'slug' | 'k8sNamespace'>;

export interface ClaimLookup {
  /** Names of the StatefulSets this application owns, live or just deleted. */
  statefulSetNames: Set<string>;
  /** PVC names Flui recorded in `app_resources` for this application. */
  trackedNames?: Set<string>;
  /**
   * Leave out clones this application's own snapshots created.
   *
   * Off by default, and that default matters: a clone carries the
   * application's label on purpose so the teardown sweeps it and the removal
   * preview warns about it — both of those must keep seeing it. Only the
   * question "which volume of this app should I copy" wants it gone, because
   * there the answer stops being unambiguous the moment somebody took a
   * snapshot. The data an application ran on before a swap, and a restored
   * copy it was never switched to, are left out for the same reason.
   */
  excludeCopies?: boolean;
}

/**
 * Which PersistentVolumeClaims belong to one application.
 *
 * One answer, two callers, and that is the point: the teardown deletes exactly
 * what this returns and the removal preview shows exactly what this returns. A
 * preview that names a volume the sweep then misses — or worse, a sweep that
 * takes one the preview never named — is how "this deletes 10 GiB" becomes a
 * lie about someone's data.
 *
 * Three ways a claim can be attributed, strongest first:
 *  - it carries `flui-app-id`, because Flui wrote it (manifest generator);
 *  - Flui recorded it as an `AppResourceEntity`;
 *  - Kubernetes minted it from a `volumeClaimTemplate`, in which case nothing
 *    on the object points back at the application and only the *name* does:
 *    `<template>-<statefulset>-<ordinal>`.
 *
 * That last rule is a suffix match, and a naive one is dangerous: a set named
 * `postgres` would claim `data-my-postgres-0`, which belongs to `my-postgres`.
 * So every StatefulSet in the namespace competes for the claim and the longest
 * name wins; a claim only counts as ours when *our* set is the winner.
 */
@Injectable()
export class ApplicationVolumeClaimsService {
  private readonly logger = new Logger(ApplicationVolumeClaimsService.name);

  constructor(private readonly kubernetesService: KubernetesService) {}

  async listForApplication(
    kubeconfig: string,
    app: ClaimOwner,
    lookup: ClaimLookup,
  ): Promise<ApplicationVolumeClaim[]> {
    const namespace = app.k8sNamespace;
    const items = await this.listAll(
      kubeconfig,
      ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
      namespace,
    );
    if (items.length === 0) return [];

    const ours = new Set(lookup.statefulSetNames);
    const competitors = new Set(ours);
    if (ours.size > 0) {
      for (const name of await this.statefulSetNamesIn(kubeconfig, namespace)) {
        competitors.add(name);
      }
    }
    const tracked = lookup.trackedNames ?? new Set<string>();

    const claims: ApplicationVolumeClaim[] = [];
    const mounted = { names: null as Set<string> | null };
    for (const item of items) {
      const name = item?.metadata?.name as string | undefined;
      if (!name) continue;
      if (
        lookup.excludeCopies &&
        (await this.isExcludedCopy(kubeconfig, app, item, name, mounted))
      ) {
        continue;
      }

      const attributedBy = this.attribute(
        name,
        item?.metadata?.labels?.['flui-app-id'] as string | undefined,
        { appId: app.id, ours, competitors, tracked },
      );
      if (!attributedBy) continue;
      claims.push(toClaim(item, name, namespace, attributedBy));
    }
    return claims;
  }

  private async isExcludedCopy(
    kubeconfig: string,
    app: ClaimOwner,
    item: any,
    name: string,
    mounted: { names: Set<string> | null },
  ): Promise<boolean> {
    const labels = item?.metadata?.labels ?? {};
    if (labels[PVC_CLONE_MARKER]) return true;
    if (labels[PREVIOUS_VOLUME_MARKER] === 'true') return true;
    if (!labels[RESTORED_FROM_MARKER]) return false;
    mounted.names ??= await this.claimsInWorkloadSpecs(kubeconfig, app);
    return !mounted.names.has(name);
  }

  /**
   * The one-call version of {@link listForApplication}: folds in the tracked
   * `app_resources` rows itself, so backup/snapshot/removal-preview don't each
   * reimplement the statefulSetNames/trackedNames split. Callers pass whatever
   * rows they already loaded (or `[]` — a StatefulSet app's claim still
   * resolves via the volumeClaimTemplate name match, since nothing records it).
   */
  async resolveForApplication(
    kubeconfig: string,
    app: ClaimOwner,
    trackedRows: ReadonlyArray<{ kind: ApplicationResourceKind; name: string }>,
    options: { excludeCopies?: boolean } = {},
  ): Promise<ApplicationVolumeClaim[]> {
    const statefulSetNames = new Set(
      trackedRows
        .filter((r) => r.kind === ApplicationResourceKind.STATEFUL_SET)
        .map((r) => r.name),
    );
    for (const name of await this.listStatefulSetsOwnedBy(kubeconfig, app)) {
      statefulSetNames.add(name);
    }
    return this.listForApplication(kubeconfig, app, {
      statefulSetNames,
      excludeCopies: options.excludeCopies,
      trackedNames: new Set(
        trackedRows
          .filter(
            (r) => r.kind === ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
          )
          .map((r) => r.name),
      ),
    });
  }

  /**
   * Who a claim belongs to. A `flui-app-id` label naming somebody else settles
   * it outright — no name heuristic gets a vote after that.
   */
  private attribute(
    name: string,
    ownerLabel: string | undefined,
    ctx: {
      appId: string;
      ours: Set<string>;
      competitors: Set<string>;
      tracked: Set<string>;
    },
  ): ClaimAttribution | null {
    if (ownerLabel) {
      return ownerLabel === ctx.appId ? 'label' : null;
    }
    if (ctx.tracked.has(name)) return 'tracked-resource';
    if (ctx.ours.has(this.winningStatefulSet(name, ctx.competitors))) {
      return 'volume-claim-template';
    }
    return null;
  }

  /**
   * Claims a workload of this application names in its spec. A swapped-in
   * copy stays named there while the application is stopped, which a look at
   * running pods would miss.
   */
  private async claimsInWorkloadSpecs(
    kubeconfig: string,
    app: Pick<ApplicationEntity, 'id' | 'k8sNamespace'>,
  ): Promise<Set<string>> {
    const names = new Set<string>();
    for (const kind of [
      ApplicationResourceKind.DEPLOYMENT,
      ApplicationResourceKind.STATEFUL_SET,
    ]) {
      const workloads = await this.kubernetesService
        .listResourcesByLabel(
          kubeconfig,
          kind,
          app.k8sNamespace,
          `flui-app-id=${app.id}`,
        )
        .catch(() => [] as any[]);
      for (const w of workloads) {
        for (const v of w?.spec?.template?.spec?.volumes ?? []) {
          const claim = v?.persistentVolumeClaim?.claimName;
          if (claim) names.add(claim);
        }
      }
    }
    return names;
  }

  /** The StatefulSets that still carry this application's own label. */
  async listStatefulSetsOwnedBy(
    kubeconfig: string,
    app: Pick<ApplicationEntity, 'id' | 'k8sNamespace'>,
  ): Promise<string[]> {
    const items = await this.kubernetesService
      .listResourcesByLabel(
        kubeconfig,
        ApplicationResourceKind.STATEFUL_SET,
        app.k8sNamespace,
        `flui-app-id=${app.id}`,
      )
      .catch(() => [] as any[]);
    return items
      .map((i: any) => i?.metadata?.name as string)
      .filter((n): n is string => !!n);
  }

  /**
   * The StatefulSet a `<template>-<set>-<ordinal>` claim belongs to, or `''`
   * when the name is not shaped like one. Longest match wins — see the class
   * comment for why a shorter one is not good enough.
   */
  private winningStatefulSet(claim: string, candidates: Set<string>): string {
    const withoutOrdinal = /^(.*)-\d+$/.exec(claim)?.[1];
    if (!withoutOrdinal) return '';
    let winner = '';
    for (const set of candidates) {
      if (!withoutOrdinal.endsWith(`-${set}`)) continue;
      if (set.length > winner.length) winner = set;
    }
    return winner;
  }

  private async statefulSetNamesIn(
    kubeconfig: string,
    namespace: string,
  ): Promise<string[]> {
    const items = await this.listAll(
      kubeconfig,
      ApplicationResourceKind.STATEFUL_SET,
      namespace,
    );
    return items
      .map((i: any) => i?.metadata?.name as string)
      .filter((n): n is string => !!n);
  }

  private async listAll(
    kubeconfig: string,
    kind: ApplicationResourceKind,
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
        `could not list ${kind} in ${namespace}: ${(err as Error).message}`,
      );
      return [];
    }
  }
}

function toClaim(
  item: any,
  name: string,
  namespace: string,
  attributedBy: ApplicationVolumeClaim['attributedBy'],
): ApplicationVolumeClaim {
  const requested =
    (item?.spec?.resources?.requests?.storage as string | undefined) ?? null;
  return {
    name,
    namespace,
    requested,
    requestedBytes: parseStorageQuantityToBytes(requested),
    storageClass: (item?.spec?.storageClassName as string | undefined) ?? null,
    phase: (item?.status?.phase as string | undefined) ?? null,
    attributedBy,
  };
}
