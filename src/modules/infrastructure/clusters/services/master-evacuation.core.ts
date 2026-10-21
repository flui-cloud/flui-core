import type * as k8s from '@kubernetes/client-node';
import { podRequest } from './unschedulable-pods.service';
import type { KubernetesService } from '../../shared/services/kubernetes.service';
import { NODE_RESERVE } from '../../scaling/engine/engine.core';
import { MovingPod, NodeRoom, checkFit } from '../../scaling/engine/fit.core';
import { isControlPlane, takesWork } from '../../scaling/engine/room.core';

const CONTROL_PLANE = 'node-role.kubernetes.io/control-plane';

export interface DeploymentRef {
  namespace: string;
  name: string;
}

export interface MasterEvacuation {
  move: DeploymentRef[];
  /** Deployments that could leave but find no worker with room for them. */
  stays: string[];
}

/**
 * Reserving the master stops new pods from landing there, but what a
 * single-node control cluster started on it would otherwise stay for good,
 * filling the one machine that is never given back. Only what declares it does
 * not belong there moves: a Deployment whose pods do not tolerate the
 * reservation and keep nothing on the master's disk. A pod that holds a claim or
 * a host path stays, and so does anything no worker has room for, because a
 * restarted pod with nowhere to go is an outage.
 */
export function planMasterEvacuation(input: {
  nodes: k8s.V1Node[];
  pods: k8s.V1Pod[];
  replicaSets: k8s.V1ReplicaSet[];
  parse: Pick<KubernetesService, 'parseCpu' | 'parseMemory'>;
}): MasterEvacuation {
  const masters = new Set(
    input.nodes.filter(isControlPlane).map((node) => node.metadata?.name),
  );
  const deploymentOf = new Map<string, string>();
  for (const rs of input.replicaSets) {
    const owner = rs.metadata?.ownerReferences?.find(
      (ref) => ref.kind === 'Deployment',
    );
    if (owner) {
      deploymentOf.set(
        `${rs.metadata?.namespace}/${rs.metadata?.name}`,
        owner.name,
      );
    }
  }

  const requested = new Map<string, { cpu: number; memory: number }>();
  const moving: MovingPod[] = [];
  const refs = new Map<string, DeploymentRef>();
  for (const pod of input.pods) {
    const on = pod.spec?.nodeName;
    if (!on || ended(pod)) continue;
    const ask = podRequest(pod, input.parse);
    if (!masters.has(on)) {
      const sum = requested.get(on) ?? { cpu: 0, memory: 0 };
      sum.cpu += ask.cpuMillicores;
      sum.memory += ask.memoryMi;
      requested.set(on, sum);
      continue;
    }
    const deployment = movableDeployment(pod, deploymentOf);
    if (!deployment) continue;
    const key = `${deployment.namespace}/${deployment.name}`;
    refs.set(key, deployment);
    moving.push({
      name: key,
      cpuMillicores: ask.cpuMillicores,
      memoryMi: ask.memoryMi,
    });
  }

  const rooms: NodeRoom[] = input.nodes
    .filter((node) => !isControlPlane(node) && takesWork(node))
    .map((node) => {
      const name = node.metadata?.name ?? '';
      const allocatable = node.status?.allocatable ?? {};
      const used = requested.get(name) ?? { cpu: 0, memory: 0 };
      return {
        name,
        cpuMillicores:
          input.parse.parseCpu(allocatable['cpu'] ?? '0') -
          used.cpu -
          NODE_RESERVE.cpuMillicores,
        memoryMi:
          input.parse.parseMemory(allocatable['memory'] ?? '0') -
          used.memory -
          NODE_RESERVE.memoryMi,
      };
    });

  const stranded = new Set(checkFit(moving, rooms).stranded);
  return {
    move: [...refs.entries()]
      .filter(([key]) => !stranded.has(key))
      .map(([, ref]) => ref),
    stays: [...stranded].sort((a, b) => (a < b ? -1 : Number(a > b))),
  };
}

function movableDeployment(
  pod: k8s.V1Pod,
  deploymentOf: Map<string, string>,
): DeploymentRef | null {
  if (toleratesReservation(pod) || keepsLocalData(pod)) return null;
  const namespace = pod.metadata?.namespace ?? '';
  const rs = pod.metadata?.ownerReferences?.find(
    (ref) => ref.kind === 'ReplicaSet',
  );
  const name = rs && deploymentOf.get(`${namespace}/${rs.name}`);
  return name ? { namespace, name } : null;
}

function toleratesReservation(pod: k8s.V1Pod): boolean {
  return (pod.spec?.tolerations ?? []).some(
    (t) =>
      (t.key === CONTROL_PLANE || (!t.key && t.operator === 'Exists')) &&
      (!t.effect || t.effect === 'NoSchedule'),
  );
}

function keepsLocalData(pod: k8s.V1Pod): boolean {
  return (pod.spec?.volumes ?? []).some(
    (volume) => volume.persistentVolumeClaim || volume.hostPath,
  );
}

function ended(pod: k8s.V1Pod): boolean {
  const phase = pod.status?.phase;
  return (
    phase === 'Succeeded' ||
    phase === 'Failed' ||
    Boolean(pod.metadata?.deletionTimestamp)
  );
}
