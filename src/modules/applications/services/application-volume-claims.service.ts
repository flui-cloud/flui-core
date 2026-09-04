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
   * snapshot.
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
    app: Pick<ApplicationEntity, 'id' | 'slug' | 'k8sNamespace'>,
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
    for (const item of items) {
      const name = item?.metadata?.name as string | undefined;
      if (!name) continue;
      if (lookup.excludeCopies && item?.metadata?.labels?.[PVC_CLONE_MARKER]) {
        continue;
      }

      const attributedBy = this.attribute(
        name,
        item?.metadata?.labels?.['flui-app-id'] as string | undefined,
        { appId: app.id, ours, competitors, tracked },
      );
      if (!attributedBy) continue;

      const requested =
        (item?.spec?.resources?.requests?.storage as string | undefined) ??
        null;
      claims.push({
        name,
        namespace,
        requested,
        requestedBytes: parseStorageQuantityToBytes(requested),
        storageClass:
          (item?.spec?.storageClassName as string | undefined) ?? null,
        phase: (item?.status?.phase as string | undefined) ?? null,
        attributedBy,
      });
    }
    return claims;
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
    app: Pick<ApplicationEntity, 'id' | 'slug' | 'k8sNamespace'>,
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
