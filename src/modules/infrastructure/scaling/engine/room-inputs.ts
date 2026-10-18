import type * as k8s from '@kubernetes/client-node';
import {
  appOfPod,
  podLimit,
  podRequest,
} from '../../clusters/services/unschedulable-pods.service';
import type { KubernetesService } from '../../shared/services/kubernetes.service';
import { NodeRoomInput, isControlPlane, takesWork } from './room.core';

type Quantities = Pick<KubernetesService, 'parseCpu' | 'parseMemory'>;
type Usage = Map<string, { cpuMillicores: number; memoryMi: number }>;

/**
 * Each node's reservations, as the scheduler counts them, from the pods that
 * are neither finished nor on their way out. Shared by the scaling engine and
 * the topology so the two never disagree about how full a node is.
 */
export function nodeRoomInputs(
  nodes: k8s.V1Node[],
  pods: k8s.V1Pod[],
  usage: Usage | null,
  parse: Quantities,
  releasing: (pod: k8s.V1Pod) => boolean = () => false,
): NodeRoomInput[] {
  const requested = new Map<string, { cpu: number; memory: number }>();
  const limited = new Map<string, { cpu: number; memory: number }>();
  const appsOn = new Map<string, Set<string>>();
  for (const pod of pods) {
    const on = pod.spec?.nodeName;
    const phase = pod.status?.phase;
    if (!on || phase === 'Succeeded' || phase === 'Failed' || releasing(pod)) {
      continue;
    }
    const ask = podRequest(pod, parse);
    const sum = requested.get(on) ?? { cpu: 0, memory: 0 };
    sum.cpu += ask.cpuMillicores;
    sum.memory += ask.memoryMi;
    requested.set(on, sum);
    const cap = podLimit(pod, parse);
    const ceiling = limited.get(on) ?? { cpu: 0, memory: 0 };
    ceiling.cpu += cap.cpuMillicores;
    ceiling.memory += cap.memoryMi;
    limited.set(on, ceiling);
    if (pod.metadata?.labels?.['flui-app-id']) {
      const here = appsOn.get(on) ?? new Set<string>();
      here.add(appOfPod(pod));
      appsOn.set(on, here);
    }
  }

  return nodes.map((item) => {
    const name = item.metadata?.name ?? '';
    const allocatable = item.status?.allocatable ?? {};
    const used = requested.get(name) ?? { cpu: 0, memory: 0 };
    return {
      name,
      role: isControlPlane(item) ? 'master' : 'worker',
      takesWork: takesWork(item, false),
      allocatable: {
        cpuMillicores: parse.parseCpu(allocatable['cpu'] ?? '0'),
        memoryMi: parse.parseMemory(allocatable['memory'] ?? '0'),
      },
      requested: { cpuMillicores: used.cpu, memoryMi: used.memory },
      limits: {
        cpuMillicores: limited.get(name)?.cpu ?? 0,
        memoryMi: limited.get(name)?.memory ?? 0,
      },
      used: usage?.get(name) ?? null,
      apps: [...(appsOn.get(name) ?? [])].sort((a, b) =>
        a < b ? -1 : Number(a > b),
      ),
    };
  });
}
