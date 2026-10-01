import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

export const VELERO_NAMESPACE = 'velero';
export const MANAGED_BY = 'managed-by';
export const MANAGED_BY_FLUI = 'flui-cloud';

export const VELERO_WORKLOADS = [
  { apiVersion: 'apps/v1', kind: 'Deployment', name: 'velero' },
  { apiVersion: 'apps/v1', kind: 'DaemonSet', name: 'node-agent' },
] as const;
export const VELERO_CREDENTIALS = {
  apiVersion: 'v1',
  kind: 'Secret',
  name: 'velero-cloud-credentials',
} as const;
export const VELERO_CLUSTER_ROLE_BINDING = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kind: 'ClusterRoleBinding',
  name: 'velero',
} as const;

const V1 = 'velero.io/v1';
const V2_ALPHA1 = 'velero.io/v2alpha1';

/** Every kind Flui's Velero install defined, with the version it serves. */
export const VELERO_KINDS: ReadonlyArray<{
  kind: string;
  plural: string;
  apiVersion: string;
}> = [
  { kind: 'Backup', plural: 'backups', apiVersion: V1 },
  { kind: 'Restore', plural: 'restores', apiVersion: V1 },
  { kind: 'Schedule', plural: 'schedules', apiVersion: V1 },
  {
    kind: 'BackupStorageLocation',
    plural: 'backupstoragelocations',
    apiVersion: V1,
  },
  {
    kind: 'VolumeSnapshotLocation',
    plural: 'volumesnapshotlocations',
    apiVersion: V1,
  },
  {
    kind: 'BackupRepository',
    plural: 'backuprepositories',
    apiVersion: V1,
  },
  {
    kind: 'PodVolumeBackup',
    plural: 'podvolumebackups',
    apiVersion: V1,
  },
  {
    kind: 'PodVolumeRestore',
    plural: 'podvolumerestores',
    apiVersion: V1,
  },
  {
    kind: 'DeleteBackupRequest',
    plural: 'deletebackuprequests',
    apiVersion: V1,
  },
  {
    kind: 'DownloadRequest',
    plural: 'downloadrequests',
    apiVersion: V1,
  },
  {
    kind: 'ServerStatusRequest',
    plural: 'serverstatusrequests',
    apiVersion: V1,
  },
  {
    kind: 'DataUpload',
    plural: 'datauploads',
    apiVersion: V2_ALPHA1,
  },
  {
    kind: 'DataDownload',
    plural: 'datadownloads',
    apiVersion: V2_ALPHA1,
  },
];

/** Flui names its kopia repositories after the application id. */
export const FLUI_REPOSITORY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const veleroDefinitionName = (plural: string) => `${plural}.velero.io`;

export interface VeleroComponent {
  kind: string;
  name: string;
  namespace?: string;
  present: boolean;
}

export interface VeleroLeftBehind {
  destinationId: string;
  destinationName: string | null;
  bucket: string | null;
  prefix: string;
  backups: number;
  /**
   * The file data of the volumes it backed up: one repository per namespace
   * under `kopia/`, beside Flui's own per-application repositories there.
   */
  volumeData: Array<{ prefix: string; bytes: number }>;
}

export interface VeleroFootprint {
  clusterId: string;
  clusterName: string;
  reachable: boolean;
  /** Anything of the old engine is still on the cluster. */
  installed: boolean;
  /** The namespace carries Flui's label, or is gone; otherwise nothing is removed. */
  installedByFlui: boolean;
  namespace: 'present' | 'terminating' | 'absent' | 'unknown';
  components: VeleroComponent[];
  definitions: string[];
  objects: number;
  /** Objects of the same kinds outside its namespace keep the definitions in place. */
  objectsElsewhere: number;
  pausedPolicies: Array<{ id: string; name: string }>;
  /** Backups it wrote, still in the destinations; nothing here deletes them. */
  leftInDestinations: VeleroLeftBehind[];
  inFlightOperationId: string | null;
}

export interface VeleroUninstallJobData {
  clusterId: string;
  operationId: string;
}

export type VeleroClusterState = Omit<
  VeleroFootprint,
  | 'clusterId'
  | 'clusterName'
  | 'pausedPolicies'
  | 'leftInDestinations'
  | 'inFlightOperationId'
>;

export function unreachableClusterState(): VeleroClusterState {
  return {
    reachable: false,
    installed: false,
    installedByFlui: false,
    namespace: 'unknown',
    components: [],
    definitions: [],
    objects: 0,
    objectsElsewhere: 0,
  };
}

export async function readVeleroOnCluster(
  k8s: KubernetesService,
  kubeconfig: string,
): Promise<VeleroClusterState> {
  const ns = await k8s.readObject(
    kubeconfig,
    'v1',
    'Namespace',
    VELERO_NAMESPACE,
  );
  let namespace: VeleroFootprint['namespace'] = 'absent';
  if (ns) {
    namespace = ns.metadata?.deletionTimestamp ? 'terminating' : 'present';
  }
  const installedByFlui =
    !ns || ns.metadata?.labels?.[MANAGED_BY] === MANAGED_BY_FLUI;

  const components: VeleroComponent[] = [];
  for (const w of [...VELERO_WORKLOADS, VELERO_CREDENTIALS]) {
    const found = ns
      ? await k8s.readObject(
          kubeconfig,
          w.apiVersion,
          w.kind,
          w.name,
          VELERO_NAMESPACE,
        )
      : null;
    components.push({
      kind: w.kind,
      name: w.name,
      namespace: VELERO_NAMESPACE,
      present: !!found,
    });
  }
  const binding = await k8s.readObject(
    kubeconfig,
    VELERO_CLUSTER_ROLE_BINDING.apiVersion,
    VELERO_CLUSTER_ROLE_BINDING.kind,
    VELERO_CLUSTER_ROLE_BINDING.name,
  );
  components.push({
    kind: VELERO_CLUSTER_ROLE_BINDING.kind,
    name: VELERO_CLUSTER_ROLE_BINDING.name,
    present: binding?.metadata?.labels?.[MANAGED_BY] === MANAGED_BY_FLUI,
  });

  const definitions: string[] = [];
  for (const k of VELERO_KINDS) {
    const crd = await k8s.readObject(
      kubeconfig,
      'apiextensions.k8s.io/v1',
      'CustomResourceDefinition',
      veleroDefinitionName(k.plural),
    );
    if (crd) definitions.push(veleroDefinitionName(k.plural));
  }

  const [objects, objectsElsewhere] = definitions.length
    ? await Promise.all([
        countVeleroObjects(k8s, kubeconfig, 'inside'),
        countVeleroObjects(k8s, kubeconfig, 'elsewhere'),
      ])
    : [0, 0];

  return {
    reachable: true,
    installed:
      namespace !== 'absent' ||
      definitions.length > 0 ||
      components.some((c) => c.present),
    installedByFlui,
    namespace,
    components,
    definitions,
    objects,
    objectsElsewhere,
  };
}

export async function countVeleroObjects(
  k8s: KubernetesService,
  kubeconfig: string,
  where: 'inside' | 'elsewhere',
): Promise<number> {
  let count = 0;
  for (const k of VELERO_KINDS) {
    const items = await k8s.listCrdResources(
      kubeconfig,
      k.kind,
      undefined,
      k.apiVersion,
    );
    count += items.filter((i: any) =>
      where === 'inside'
        ? i?.metadata?.namespace === VELERO_NAMESPACE
        : i?.metadata?.namespace !== VELERO_NAMESPACE,
    ).length;
  }
  return count;
}
