import {
  MachineArchitecture,
  NODE_RESERVE,
  NodeReserve,
  ShapeFact,
} from './engine.core';

/**
 * What a node already running gives away before an app gets any of it, taken
 * apart so a machine not yet bought can be weighed the same way.
 */
export interface NodeOverhead {
  role: 'master' | 'worker';
  /** What the provider sells the machine as. Null where its shape is unknown. */
  nominal: NodeReserve | null;
  capacity: NodeReserve;
  allocatable: NodeReserve;
  /** What runs on every machine: it arrives on a new node before any app does. */
  everyNode: NodeReserve;
}

/**
 * The share of a new machine the system takes, as measured on the nodes there
 * are: the gap between what the provider sells and what the node offers, plus
 * what runs on every node, plus the headroom every room reading keeps free.
 *
 * Workers are the measure where there are any, because a new node is one. The
 * largest gap wins: the cautious reading keeps a too-small machine off the list
 * rather than buying one that leaves the app waiting.
 */
export function measuredReserve(nodes: NodeOverhead[]): NodeReserve {
  const workers = nodes.filter((node) => node.role === 'worker');
  const pool = workers.length ? workers : nodes;
  let cpu = 0;
  let memory = 0;
  for (const node of pool) {
    const sold = node.nominal ?? node.capacity;
    cpu = Math.max(
      cpu,
      sold.cpuMillicores -
        node.allocatable.cpuMillicores +
        node.everyNode.cpuMillicores,
    );
    memory = Math.max(
      memory,
      sold.memoryMi - node.allocatable.memoryMi + node.everyNode.memoryMi,
    );
  }
  return {
    cpuMillicores: NODE_RESERVE.cpuMillicores + Math.max(0, Math.round(cpu)),
    memoryMi: NODE_RESERVE.memoryMi + Math.max(0, Math.round(memory)),
  };
}

/**
 * What the fleet runs on, from the provider's own word about each node's
 * machine. Null where no node's machine says, or where the fleet mixes both —
 * then nothing is refused on architecture.
 */
export function fleetArchitecture(
  shapesOfNodes: string[],
  facts: ShapeFact[],
): MachineArchitecture | null {
  const seen = new Set<MachineArchitecture>();
  for (const shape of shapesOfNodes) {
    const arch = facts.find((fact) => fact.shape === shape)?.architecture;
    if (arch) seen.add(arch);
  }
  return seen.size === 1 ? [...seen][0] : null;
}
