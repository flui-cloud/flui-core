import { WorkloadRef } from './manifest-documents.util';

export interface RolloutState {
  ready: boolean;
  detail: string;
}

interface Obj {
  metadata?: { generation?: number };
  spec?: { replicas?: number; updateStrategy?: { type?: string } };
  status?: Record<string, unknown>;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function observed(obj: Obj): boolean {
  return num(obj.status?.observedGeneration) >= num(obj.metadata?.generation);
}

function deployment(obj: Obj): RolloutState {
  const desired = obj.spec?.replicas ?? 1;
  const updated = num(obj.status?.updatedReplicas);
  const available = num(obj.status?.availableReplicas);
  return {
    ready:
      desired === 0 ||
      (observed(obj) && updated >= desired && available >= desired),
    detail: `${available}/${desired} available, ${updated} updated`,
  };
}

function statefulSet(obj: Obj): RolloutState {
  const desired = obj.spec?.replicas ?? 1;
  const ready = num(obj.status?.readyReplicas);
  const current = obj.status?.currentRevision;
  const update = obj.status?.updateRevision;
  const onNewRevision =
    obj.spec?.updateStrategy?.type === 'OnDelete' ||
    !update ||
    current === update ||
    num(obj.status?.updatedReplicas) >= desired;
  return {
    ready:
      desired === 0 || (observed(obj) && onNewRevision && ready >= desired),
    detail: `${ready}/${desired} ready`,
  };
}

function daemonSet(obj: Obj): RolloutState {
  const desired = num(obj.status?.desiredNumberScheduled);
  const updated = num(obj.status?.updatedNumberScheduled);
  const available = num(obj.status?.numberAvailable);
  return {
    ready:
      desired === 0 ||
      (observed(obj) && updated >= desired && available >= desired),
    detail: `${available}/${desired} available`,
  };
}

/** Whether a workload read from the cluster has finished rolling out. */
export function rolloutOf(kind: string, obj: Obj | null): RolloutState {
  if (!obj) return { ready: false, detail: 'not created yet' };
  switch (kind) {
    case 'Deployment':
      return deployment(obj);
    case 'StatefulSet':
      return statefulSet(obj);
    case 'DaemonSet':
      return daemonSet(obj);
    default:
      return { ready: true, detail: '' };
  }
}

export const workloadLabel = (w: WorkloadRef): string =>
  `${w.kind} ${w.namespace}/${w.name}`;
