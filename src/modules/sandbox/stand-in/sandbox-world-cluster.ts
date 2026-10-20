/**
 * The tabs of a cluster page that describe the machine room rather than the
 * guest's applications: shared storage, the snapshots on it, cluster-wide
 * variables. The bill is in `sandbox-world-billing.ts`.
 *
 * Each answer carries the cluster id it was asked for, and is otherwise the
 * example organisation's cluster: its applications, its volume, its machines.
 * The real answers are the instance's provider volume, every tenant's claims
 * and the operator's invoice, none of which a tenancy has any business seeing.
 *
 * The rules of `sandbox-world.ts` hold here too, the fifth above all: a
 * sensitive variable set is shown by its key names, the way the real API shows
 * it, and never with a value — not even an invented one.
 */
import { formatStorageBytes } from '../../../common/utils/storage-quantity.util';
import {
  FLUI_SHARED_STORAGE_PATH,
  FLUI_SHARED_VOLUME_FS_LABEL,
  NFS_EXPORT_OPTIONS,
  NFS_MOUNT_OPTIONS,
} from '../../infrastructure/clusters/constants/storage-conventions';
import {
  APPS,
  CLUSTER_ID,
  daysAgo,
  hoursAgo,
  mark,
  PROVIDER,
  REGION,
  SandboxStandInQuery,
} from './sandbox-world-core';
import { SHARED_VOLUME } from './sandbox-world-fleet';

type Params = Record<string, string | undefined>;

const GIB = 1024 ** 3;

export const clusterOf = (params?: Params): string =>
  params?.clusterId ?? params?.id ?? CLUSTER_ID;

const namespaceOf = (app: (typeof APPS)[number]): string => `p-${app.project}`;

const [, , POSTGRES] = APPS;
const SHOP = APPS[0];

/** The claims on the shared volume: the applications that keep data. */
const CLAIMS = [
  { app: POSTGRES, name: 'data-postgres-0', gb: 20 },
  { app: SHOP, name: 'data-meilisearch-0', gb: 4 },
  { app: SHOP, name: 'data-redis-0', gb: 1 },
];

export function exampleClusterStorage(
  _now: number,
  _query?: SandboxStandInQuery,
  params?: Params,
) {
  const byNamespace: Record<string, number> = {};
  for (const claim of CLAIMS) {
    const ns = namespaceOf(claim.app);
    byNamespace[ns] = (byNamespace[ns] ?? 0) + 1;
  }
  return mark({
    status: 'READY',
    enabled: true,
    clusterId: clusterOf(params),
    volume: mark({
      provider: PROVIDER,
      volumeId: SHARED_VOLUME.id,
      sizeGb: SHARED_VOLUME.sizeGb,
      mountPath: FLUI_SHARED_STORAGE_PATH,
      fsLabel: FLUI_SHARED_VOLUME_FS_LABEL,
    }),
    nfs: mark({
      exportPath: FLUI_SHARED_STORAGE_PATH,
      exportOptions: NFS_EXPORT_OPTIONS,
      mountOptions: NFS_MOUNT_OPTIONS,
    }),
    pvcs: mark({
      bound: CLAIMS.length,
      requestedGb: CLAIMS.reduce((sum, c) => sum + c.gb, 0),
      byNamespace,
    }),
  });
}

/**
 * One claim left behind by an application the organisation deleted. Enough to
 * show what the list is for; the delete button beside it is refused like every
 * other write in an example section.
 */
export function exampleOrphanedClaims(
  now: number,
  _query?: SandboxStandInQuery,
  params?: Params,
) {
  const requestedBytes = 5 * GIB;
  const claims = [
    mark({
      name: 'data-search-0',
      namespace: namespaceOf(SHOP),
      requested: '5Gi',
      requestedBytes,
      sizeLabel: formatStorageBytes(requestedBytes),
      storageClass: 'flui-shared',
      phase: 'Bound',
      createdAt: daysAgo(now, 21),
      lastKnownApplication: mark({
        id: 'example-app-5',
        name: 'Search',
        deletedAt: daysAgo(now, 9),
      }),
      reason: 'its application "Search" was deleted and no pod mounts it',
    }),
  ];
  const totalBytes = claims.reduce((sum, c) => sum + c.requestedBytes, 0);
  return mark({
    clusterId: clusterOf(params),
    namespacesScanned: [...new Set(APPS.map(namespaceOf))],
    claims,
    totalBytes,
    totalLabel: formatStorageBytes(totalBytes),
  });
}

/** Two copies of the shop's database, the one application whose data matters most. */
export function exampleClusterSnapshots(now: number) {
  const claim = CLAIMS.find((c) => c.app.id === POSTGRES.id)!;
  const snapshot = (index: number, createdAt: string, usedGib: number) =>
    mark({
      exportId: `example-snapshot-${index}`,
      sink: 'pvc-clone',
      namespace: namespaceOf(POSTGRES),
      sourcePvcName: claim.name,
      appId: POSTGRES.id,
      sizeGb: claim.gb,
      actualBytes: Math.round(usedGib * GIB),
      createdAt,
      ready: true,
      labels: {
        'flui.cloud/managed-by': 'flui-cloud',
        'flui-app-id': POSTGRES.id,
        'flui.cloud/source-pvc': claim.name,
        'flui.cloud/snapshot-trigger': 'manual',
      },
      provider: PROVIDER,
      providerCapabilities: {
        pvcCloneSupportsCheapRetention: false,
        s3ArchiveSupportsCheapRetention: true,
        pvcClonePricePerGbMonthEur: null,
        s3ArchivePricePerGbMonthEur: null,
      },
    });
  return [
    snapshot(1, hoursAgo(now, 20), 3.4),
    snapshot(2, daysAgo(now, 8), 3.1),
  ];
}

/**
 * The organisation's cluster-wide variables, in the namespace the tab opens on.
 * The plain set is shown with its values because they are configuration, not
 * credentials. The sensitive set is shown the way the real API shows one: its
 * key names, and nothing else.
 */
const VARIABLE_SETS = [
  {
    name: 'northwind-shared',
    type: 'plain' as const,
    scope: 'shared' as const,
    resourceVersion: '4182',
    data: {
      LOG_LEVEL: 'info',
      REGION,
      TZ: 'Europe/Berlin',
      FEATURE_FLAGS: 'new-checkout,express-shipping',
      PUBLIC_BASE_URL: 'https://shop.northwind-labs.eu',
    } as Record<string, string>,
  },
  {
    name: 'northwind-shared-sensitive',
    type: 'sensitive' as const,
    scope: 'shared' as const,
    resourceVersion: '4190',
    keys: ['ORDERS_DATABASE_URL', 'PAYMENTS_API_KEY', 'SMTP_CREDENTIALS'],
  },
];

const EXAMPLE_NAMESPACE = 'default';

export function exampleClusterVariableSets(
  _now: number,
  query?: SandboxStandInQuery,
  params?: Params,
) {
  if ((params?.namespace ?? EXAMPLE_NAMESPACE) !== EXAMPLE_NAMESPACE) return [];
  const type = typeof query?.type === 'string' ? query.type : 'all';
  return VARIABLE_SETS.filter((set) => type === 'all' || set.type === type).map(
    (set) =>
      set.type === 'plain'
        ? mark({
            name: set.name,
            type: set.type,
            scope: set.scope,
            resourceVersion: set.resourceVersion,
            keys: Object.keys(set.data),
            data: { ...set.data },
          })
        : mark({
            name: set.name,
            type: set.type,
            scope: set.scope,
            resourceVersion: set.resourceVersion,
            keys: [...set.keys],
          }),
  );
}

export function exampleClusterVariableSet(
  _now: number,
  query?: SandboxStandInQuery,
  params?: Params,
) {
  if ((params?.namespace ?? EXAMPLE_NAMESPACE) !== EXAMPLE_NAMESPACE) {
    return null;
  }
  const set = VARIABLE_SETS.find((s) => s.name === params?.name);
  if (!set) return null;
  const asked = query?.type === 'sensitive' ? 'sensitive' : 'plain';
  if (asked !== set.type) return null;
  return set.type === 'plain'
    ? mark({
        name: set.name,
        type: set.type,
        scope: set.scope,
        data: { ...set.data },
        resourceVersion: set.resourceVersion,
      })
    : mark({
        name: set.name,
        type: set.type,
        scope: set.scope,
        keys: [...set.keys],
        resourceVersion: set.resourceVersion,
      });
}
