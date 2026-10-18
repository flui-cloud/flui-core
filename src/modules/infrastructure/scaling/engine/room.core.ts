/**
 * How much room the fleet has left, the way the scheduler counts it.
 *
 * What an app reserves, not what it uses: a node can look idle on every
 * consumption graph and be full for placing the next app, and it is the
 * reservation that decides whether a node gets bought. The reserve kept for
 * the system on each node is set aside first, exactly as the engine does.
 */

import type * as k8s from '@kubernetes/client-node';

export interface NodeRoomInput {
  name: string;
  role: 'master' | 'worker';
  /** Whether new apps may be placed here: ready, not cordoned, not refusing work. */
  takesWork: boolean;
  allocatable: { cpuMillicores: number; memoryMi: number };
  requested: { cpuMillicores: number; memoryMi: number };
  /** What the same pods may grow to, each container at its limit. */
  limits: { cpuMillicores: number; memoryMi: number };
  /** What they use right now; null when the node's usage could not be read. */
  used: { cpuMillicores: number; memoryMi: number } | null;
  /** The applications with a replica here, by the name `flui app` takes. */
  apps: string[];
}

export interface NodeRoom extends NodeRoomInput {
  free: { cpuMillicores: number; memoryMi: number };
}

export interface FleetRoom {
  nodes: NodeRoom[];
  /**
   * The largest app that still fits somewhere, as the room left on the node
   * with the most memory free. Null when no node takes work.
   */
  largestFit: { cpuMillicores: number; memoryMi: number; node: string } | null;
}

export function fleetRoom(
  nodes: NodeRoomInput[],
  reserve: { cpuMillicores: number; memoryMi: number },
): FleetRoom {
  const withFree: NodeRoom[] = nodes.map((node) => ({
    ...node,
    free: {
      cpuMillicores: Math.max(
        0,
        node.allocatable.cpuMillicores -
          node.requested.cpuMillicores -
          reserve.cpuMillicores,
      ),
      memoryMi: Math.max(
        0,
        node.allocatable.memoryMi - node.requested.memoryMi - reserve.memoryMi,
      ),
    },
  }));

  const open = withFree.filter((node) => node.takesWork);
  const roomiest = open.reduce<NodeRoom | null>(
    (best, node) =>
      !best ||
      node.free.memoryMi > best.free.memoryMi ||
      (node.free.memoryMi === best.free.memoryMi &&
        node.free.cpuMillicores > best.free.cpuMillicores)
        ? node
        : best,
    null,
  );

  return {
    nodes: withFree,
    largestFit: roomiest ? { ...roomiest.free, node: roomiest.name } : null,
  };
}

export function isControlPlane(node: k8s.V1Node): boolean {
  const labels = node.metadata?.labels ?? {};
  return (
    'node-role.kubernetes.io/control-plane' in labels ||
    'node-role.kubernetes.io/master' in labels
  );
}

/**
 * A machine that would take evicted work: ready, not cordoned, and not refusing
 * new pods by taint. A taint is read as a refusal whatever it tolerates, which
 * can keep a node that could have gone — the cheaper of the two mistakes.
 */
export function takesWork(node: k8s.V1Node, reopensMaster = false): boolean {
  if (node.spec?.unschedulable) return false;
  const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') return false;
  const refuses = (node.spec?.taints ?? []).some(
    (taint) => taint.effect === 'NoSchedule' || taint.effect === 'NoExecute',
  );
  return !refuses || (reopensMaster && isControlPlane(node));
}
