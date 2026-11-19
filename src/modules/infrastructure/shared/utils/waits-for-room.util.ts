import * as k8s from '@kubernetes/client-node';

/**
 * Where a volume, not a node, is what is missing: pinned to a machine, or no
 * room published for its storage. A node added by scaling would not help.
 */
const VOLUME_BOUND =
  /volume node affinity conflict|did not have enough free storage/i;

/** Pending because no node has room for it — not starting, and not held back by its volume. */
export function waitsForRoom(pod: k8s.V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return false;
  const condition = scheduledFalse(pod);
  return (
    condition?.reason === 'Unschedulable' &&
    !VOLUME_BOUND.test(condition.message ?? '')
  );
}

/** Seconds since the scheduler first said it has no room, or null when it has not said so. */
export function roomWaitSeconds(
  pod: k8s.V1Pod,
  now = Date.now(),
): number | null {
  if (!waitsForRoom(pod)) return null;
  const at =
    scheduledFalse(pod)?.lastTransitionTime ?? pod.metadata?.creationTimestamp;
  const stamp = at ? new Date(at).getTime() : Number.NaN;
  return Number.isFinite(stamp) ? Math.max(0, (now - stamp) / 1000) : 0;
}

function scheduledFalse(pod: k8s.V1Pod): k8s.V1PodCondition | undefined {
  return (pod.status?.conditions ?? []).find(
    (c) => c.type === 'PodScheduled' && c.status === 'False',
  );
}

export class WaitingForRoomError extends Error {
  constructor(
    readonly workload: string,
    readonly replicas: number,
  ) {
    super(
      `${workload}: ${replicas} replica${replicas === 1 ? '' : 's'} waiting for a node with room`,
    );
  }
}
