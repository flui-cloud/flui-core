import { HaCandidateNode } from '../../postgres-ha/utils/postgres-ha-feasibility.core';
import { HaTopology } from '../../providers/core/ha-topology';
import {
  PIRAEUS_API_VERSION,
  REPLICATED_POOL,
  REPLICATED_POOL_FILE,
  REPLICATED_STORAGE_CLASS,
  REPLICATED_STORAGE_NODE_LABEL,
  REPLICATED_VOLUME_GROUP,
} from '../replicated-volumes.constants';
import { TOPOLOGY_ZONE_LABEL } from '../../providers/core/node-topology';

const DRBD_OPTION = 'property.linstor.csi.linbit.com/DrbdOptions';

/**
 * The components that attach volumes and keep the engine's records run as a
 * single copy; lost with a location that holds data, no volume could move
 * until Kubernetes moved them minutes later. They stay off the nodes with
 * copies and, where the layout has one, in the voting location: losing that
 * location never asks a volume to move.
 */
const awayFromCopies = (voteZones: string[]) => ({
  podTemplate: {
    spec: {
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  {
                    key: REPLICATED_STORAGE_NODE_LABEL,
                    operator: 'DoesNotExist',
                  },
                  ...(voteZones.length
                    ? [
                        {
                          key: TOPOLOGY_ZONE_LABEL,
                          operator: 'In',
                          values: voteZones,
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
        },
      },
      tolerations: [{ operator: 'Exists', effect: 'NoSchedule' }],
    },
  },
});

/** The locations that only vote; none on a forced region, where every location holds data. */
export function voteZonesOf(topology: HaTopology): string[] {
  return topology.zones.filter((z) => !topology.dataZones.includes(z));
}

/**
 * The volume engine with the parts Flui does not use switched off: the NFS
 * server on top of replicated volumes stays out until something asks for it.
 */
export function renderLinstorCluster(
  voteZones: string[] = [],
): Record<string, unknown> {
  return {
    apiVersion: PIRAEUS_API_VERSION,
    kind: 'LinstorCluster',
    metadata: { name: 'linstorcluster' },
    spec: {
      nfsServer: { enabled: false },
      highAvailabilityController: { enabled: true },
      controller: awayFromCopies(voteZones),
      csiController: awayFromCopies(voteZones),
      affinityController: awayFromCopies(voteZones),
    },
  };
}

/**
 * Two satellite settings. Every node runs on the host network, so copies
 * travel on the nodes' own network and not the slower pod network, and any
 * node can cast the tie-breaking vote; its DRBD metrics are read like any
 * other pod's, for the alerts on copies. Only the nodes Flui prepared hold data.
 */
export function renderSatelliteConfigurations(): Record<string, unknown>[] {
  return [
    {
      apiVersion: PIRAEUS_API_VERSION,
      kind: 'LinstorSatelliteConfiguration',
      metadata: { name: 'flui-host-network' },
      spec: {
        podTemplate: {
          metadata: {
            annotations: {
              'prometheus.io/scrape': 'true',
              'prometheus.io/port': '9942',
              'prometheus.io/path': '/metrics',
            },
          },
          spec: { hostNetwork: true },
        },
      },
    },
    {
      apiVersion: PIRAEUS_API_VERSION,
      kind: 'LinstorSatelliteConfiguration',
      metadata: { name: 'flui-replicated-pool' },
      spec: {
        nodeSelector: { [REPLICATED_STORAGE_NODE_LABEL]: 'true' },
        storagePools: [
          {
            name: REPLICATED_POOL,
            lvmPool: { volumeGroup: REPLICATED_VOLUME_GROUP },
          },
        ],
      },
    },
  ];
}

/**
 * Two synchronous copies, only on prepared nodes, each in its own location, and
 * a pod only where a copy is. Quorum is asked for explicitly: without it a node
 * cut off from the other keeps confirming writes only it holds, and nothing
 * moves the pod. The rule on locations also holds for the tie-breaker, which
 * needs no storage pool, so it lands in the third location.
 */
export function renderReplicatedStorageClass(): Record<string, unknown> {
  return {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: REPLICATED_STORAGE_CLASS,
      labels: { 'flui.cloud/managed-by': 'flui-cloud' },
    },
    provisioner: 'linstor.csi.linbit.com',
    allowVolumeExpansion: true,
    volumeBindingMode: 'WaitForFirstConsumer',
    reclaimPolicy: 'Delete',
    parameters: {
      'linstor.csi.linbit.com/storagePool': REPLICATED_POOL,
      'linstor.csi.linbit.com/placementCount': '2',
      'linstor.csi.linbit.com/allowRemoteVolumeAccess': 'false',
      'linstor.csi.linbit.com/replicasOnDifferent':
        'Aux/topology/topology.kubernetes.io/zone',
      'csi.storage.k8s.io/fstype': 'ext4',
      [`${DRBD_OPTION}/auto-quorum`]: 'suspend-io',
      [`${DRBD_OPTION}/Resource/on-no-data-accessible`]: 'suspend-io',
      [`${DRBD_OPTION}/Resource/on-suspended-primary-outdated`]:
        'force-secondary',
      [`${DRBD_OPTION}/Net/rr-conflict`]: 'retry-connect',
    },
  };
}

/**
 * Prepares one node to hold copies: kernel headers for the DRBD module,
 * a plain (not thin) volume group on a direct-I/O loop file with 4K sectors,
 * and a unit that brings the loop back at boot. Thin pools double the cost of
 * a copy; a new volume is copied whole once, so the file is allocated on the
 * disk for real, not left sparse.
 */
export function replicatedPoolHostScript(sizeGiB: number): string {
  if (!Number.isInteger(sizeGiB) || sizeGiB < 1) {
    throw new Error(`invalid pool size ${sizeGiB}`);
  }
  const dir = REPLICATED_POOL_FILE.slice(
    0,
    REPLICATED_POOL_FILE.lastIndexOf('/'),
  );
  return [
    'set -e',
    `FILE=${REPLICATED_POOL_FILE}`,
    `VG=${REPLICATED_VOLUME_GROUP}`,
    'export DEBIAN_FRONTEND=noninteractive',
    'KREL=$(uname -r)',
    'if [ ! -d "/lib/modules/$KREL/build" ]; then',
    '  apt-get update -qq >/dev/null 2>&1 || true',
    '  apt-get install -y -qq "linux-headers-$KREL" >/dev/null 2>&1 || true',
    '  apt-get install -y -qq "linux-headers-${KREL##*-}" >/dev/null 2>&1 || true',
    'fi',
    'if [ ! -d "/lib/modules/$KREL/build" ]; then echo "NOHEADERS $KREL"; exit 0; fi',
    'command -v vgcreate >/dev/null 2>&1 || apt-get install -y -qq lvm2 >/dev/null 2>&1 || true',
    'if ! vgs "$VG" >/dev/null 2>&1; then',
    `  mkdir -p ${dir}`,
    '  if [ ! -f "$FILE" ]; then',
    `    FREE=$(df -B1G --output=avail ${dir} | tail -1 | tr -d ' ')`,
    `    if [ "$FREE" -lt $(( ${sizeGiB} + 5 )) ]; then echo "NOSPACE $FREE"; exit 0; fi`,
    `    fallocate -l ${sizeGiB}G "$FILE" || { rm -f "$FILE"; echo "NOALLOC"; exit 0; }`,
    '  fi',
    '  DEV=$(losetup -j "$FILE" -O NAME -n | head -1)',
    '  [ -n "$DEV" ] || DEV=$(losetup --find --show --direct-io=on --sector-size 4096 "$FILE")',
    '  pvcreate -q "$DEV" >/dev/null',
    '  vgcreate -q "$VG" "$DEV" >/dev/null',
    'fi',
    // A pool made before the file was allocated is sparse: its blocks are
    // taken only as copies are written, and a disk filled by anything else
    // turns those writes into I/O errors. Allocating it is safe on a live
    // loop device and changes nothing already written.
    'if [ -f "$FILE" ] && [ "$(du -B1 "$FILE" | cut -f1)" -lt "$(stat -c %s "$FILE")" ]; then',
    '  fallocate -l "$(stat -c %s "$FILE")" "$FILE" || echo "NOALLOC"',
    'fi',
    "cat > /usr/local/sbin/flui-replicated-pool <<'FLUIHELPER'",
    '#!/bin/sh',
    `f=${REPLICATED_POOL_FILE}`,
    '[ -f "$f" ] || exit 0',
    'dev=$(losetup -j "$f" -O NAME -n | head -1)',
    '[ -n "$dev" ] || losetup --find --direct-io=on --sector-size 4096 "$f"',
    `exec vgchange -q -ay ${REPLICATED_VOLUME_GROUP}`,
    'FLUIHELPER',
    'chmod 755 /usr/local/sbin/flui-replicated-pool',
    "cat > /etc/systemd/system/flui-replicated-pool.service <<'FLUIUNIT'",
    '[Unit]',
    'Description=Loop device and volume group of Flui replicated volumes',
    `RequiresMountsFor=${dir}`,
    'Before=k3s.service k3s-agent.service',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/local/sbin/flui-replicated-pool',
    'RemainAfterExit=yes',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'FLUIUNIT',
    'systemctl daemon-reload >/dev/null 2>&1 || true',
    'systemctl enable flui-replicated-pool.service >/dev/null 2>&1 || true',
    'echo "POOL $VG $(vgs --noheadings --units g --nosuffix -o vg_size "$VG" | tr -d \' \')"',
  ].join('\n');
}

export type ReplicatedPoolState =
  | { kind: 'ready'; sizeGiB: number }
  | { kind: 'no-headers'; kernel: string }
  | { kind: 'no-space'; freeGiB: number }
  | { kind: 'no-alloc' }
  | { kind: 'unknown'; detail: string };

export function parseReplicatedPoolOutput(logs: string): ReplicatedPoolState {
  for (const raw of logs.split('\n')) {
    const line = raw.trim();
    const pool = /^POOL \S+ (\d+(?:\.\d+)?)$/.exec(line);
    if (pool) return { kind: 'ready', sizeGiB: Math.floor(Number(pool[1])) };
    const headers = /^NOHEADERS (\S+)$/.exec(line);
    if (headers) return { kind: 'no-headers', kernel: headers[1] };
    const space = /^NOSPACE (\d+)$/.exec(line);
    if (space) return { kind: 'no-space', freeGiB: Number(space[1]) };
    if (line === 'NOALLOC') return { kind: 'no-alloc' };
  }
  return { kind: 'unknown', detail: logs.trim().slice(-200) };
}

export type ReplicatedVolumesFeasibility =
  | {
      feasible: true;
      zones: string[];
      storageNodes: string[];
      tieBreakers: string[];
    }
  | { feasible: false; reason: string };

/**
 * Which nodes hold the copies: one that takes applications in each of the
 * layout's locations for data, and the nodes of the remaining location for
 * the tie-breaking vote. Nodes already prepared are kept when they still fit,
 * so enabling again does not move copies around.
 */
export function replicatedVolumesFeasibility(
  nodes: HaCandidateNode[],
  topology: HaTopology,
  options: { requested?: string[]; prepared?: string[] } = {},
): ReplicatedVolumesFeasibility {
  const fits = (n: HaCandidateNode) =>
    n.schedulable && !!n.zone && topology.dataZones.includes(n.zone);
  let storage: HaCandidateNode[];
  if (options.requested?.length) {
    const unknown = options.requested.filter(
      (r) => !nodes.some((n) => n.name === r),
    );
    if (unknown.length) {
      return {
        feasible: false,
        reason: `No node named ${unknown.join(', ')} in this cluster.`,
      };
    }
    storage = nodes.filter((n) => options.requested!.includes(n.name));
    const blocked = storage.filter((n) => !fits(n));
    if (blocked.length) {
      return {
        feasible: false,
        reason: `${blocked.map((n) => n.name).join(', ')} cannot hold copies: a node that holds one must take applications and sit in ${topology.dataZones.join(' or ')}.`,
      };
    }
    if (
      new Set(storage.map((n) => n.zone)).size !== 2 ||
      storage.length !== 2
    ) {
      return {
        feasible: false,
        reason: `The two copies go in two different locations among ${topology.dataZones.join(', ')}.`,
      };
    }
  } else {
    const prepared = new Set(options.prepared ?? []);
    const pick = (zone: string) =>
      nodes
        .filter((n) => fits(n) && n.zone === zone)
        .sort(
          (a, b) =>
            Number(prepared.has(b.name)) - Number(prepared.has(a.name)) ||
            a.name.localeCompare(b.name),
        )[0];
    storage = topology.dataZones
      .map(pick)
      .filter((n): n is HaCandidateNode => !!n)
      .slice(0, 2);
    if (storage.length < 2) {
      return {
        feasible: false,
        reason: `Replicated volumes need a node that takes applications in ${topology.dataZones.join(' and ')}.`,
      };
    }
  }
  const zones = storage.map((n) => n.zone!).sort((a, b) => a.localeCompare(b));
  const storageNames = storage
    .map((n) => n.name)
    .sort((a, b) => a.localeCompare(b));
  const tieBreakers = nodes
    .filter((n) => !!n.zone && !zones.includes(n.zone))
    .map((n) => n.name);
  if (!tieBreakers.length) {
    return {
      feasible: false,
      reason: `Copies in ${zones.join(' and ')} need a node in a third location for the tie-breaking vote.`,
    };
  }
  return { feasible: true, zones, storageNodes: storageNames, tieBreakers };
}

const CONTROL_COMPONENTS = [
  'linstor-controller',
  'linstor-csi-controller',
  'linstor-affinity-controller',
];

/**
 * The engine's single-copy components that sit on a node holding copies. The
 * placement rule only applies when a pod is placed, so a node prepared after
 * the engine was installed keeps whatever already ran there.
 */
export function controlPodsOnCopies(
  pods: Array<{ metadata?: { name?: string }; spec?: { nodeName?: string } }>,
  storageNodes: string[],
): string[] {
  return pods
    .filter((p) => {
      const name = p.metadata?.name ?? '';
      return (
        CONTROL_COMPONENTS.some((c) => name.startsWith(`${c}-`)) &&
        storageNodes.includes(p.spec?.nodeName ?? '')
      );
    })
    .map((p) => p.metadata!.name!);
}

export interface VolumeClassLike {
  name: string;
  storageClass?: string | null;
}

/**
 * A pod moves to the other copy only when every volume it mounts can follow
 * it; one volume of another kind keeps it on the lost node. Returns the
 * volumes that would hold it back, empty when the app is fine or uses no
 * replicated volume at all.
 */
export function volumesBlockingFailover(volumes: VolumeClassLike[]): string[] {
  const replicated = volumes.some(
    (v) => v.storageClass === REPLICATED_STORAGE_CLASS,
  );
  if (!replicated) return [];
  return volumes
    .filter((v) => v.storageClass !== REPLICATED_STORAGE_CLASS)
    .map((v) => v.name);
}

/**
 * Copies on a node that takes no applications cannot be followed: when the
 * other node is lost, the application has nowhere to start with its data.
 */
export function storageNodeWarnings(
  nodes: HaCandidateNode[],
  storageNodes: string[],
): string[] {
  return storageNodes
    .filter((name) => nodes.find((n) => n.name === name)?.schedulable === false)
    .map(
      (name) =>
        `${name} holds copies but takes no applications, so an application cannot move to it. Keep copies on nodes that run applications.`,
    );
}

export interface VolumeCopyState {
  volume: string;
  node: string;
  disk: string;
  inUse: boolean;
}

/** `linstor -m --output-version v1 resource list`: one list of resources, one per volume and node. */
export function volumeCopiesFrom(linstorJson: string): VolumeCopyState[] {
  const parsed = JSON.parse(linstorJson) as unknown[];
  const resources = (Array.isArray(parsed[0]) ? parsed[0] : parsed) as Array<{
    name: string;
    node_name: string;
    state?: { in_use?: boolean };
    volumes?: Array<{ state?: { disk_state?: string } }>;
  }>;
  return resources.map((r) => ({
    volume: r.name,
    node: r.node_name,
    disk: r.volumes?.[0]?.state?.disk_state ?? 'Unknown',
    inUse: r.state?.in_use === true,
  }));
}

/**
 * A copy that is not up to date leaves the volume on one real copy: the next
 * loss stops it. DRBD 9.3.4 can leave a copy in that state with its data
 * already complete after a short loss of the node the application ran on
 * (LINBIT/drbd#153); bringing it back means stopping the application for a
 * moment, so Flui says so instead of doing it.
 */
export function staleCopyWarnings(
  copies: VolumeCopyState[],
  claimOf: Map<string, string>,
): string[] {
  return copies
    .filter((c) => c.disk !== 'UpToDate' && c.disk !== 'Diskless')
    .map((c) => {
      const others = copies
        .filter(
          (o) =>
            o.volume === c.volume && o.node !== c.node && o.disk === 'UpToDate',
        )
        .map((o) => o.node);
      const name = claimOf.get(c.volume) ?? c.volume;
      return `The copy of ${name} on ${c.node} is not up to date (${c.disk}): until it is, losing ${others.join(' or ') || 'the other copy'} stops the volume.${c.inUse ? ' The application runs on this copy.' : ''}`;
    });
}
