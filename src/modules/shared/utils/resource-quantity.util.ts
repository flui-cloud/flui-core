const CPU_PATTERN = /^(\d+(?:\.\d+)?)(m?)$/;
const MEMORY_PATTERN = /^(\d+(?:\.\d+)?)(m|k|Ki|Mi|Gi|Ti|K|M|G|T)?$/;

const BYTES_PER: Record<string, number> = {
  '': 1,
  m: 0.001,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

export class ResourceQuantityError extends Error {}

export function cpuMillicoresOf(quantity: string): number {
  const match = CPU_PATTERN.exec(quantity.trim());
  if (!match) {
    throw new ResourceQuantityError(
      `"${quantity}" is not a CPU quantity: use cores ("0.5", "2") or millicores ("500m")`,
    );
  }
  const value = Number(match[1]);
  const millicores = Math.ceil(match[2] === 'm' ? value : value * 1000);
  if (millicores < 1) {
    throw new ResourceQuantityError(
      `CPU must be at least 1m, not "${quantity}"`,
    );
  }
  return millicores;
}

export function memoryMiOf(quantity: string): number {
  const match = MEMORY_PATTERN.exec(quantity.trim());
  if (!match) {
    throw new ResourceQuantityError(
      `"${quantity}" is not a memory quantity: use "256Mi" or "2Gi"`,
    );
  }
  const bytes = Number(match[1]) * BYTES_PER[match[2] ?? ''];
  const mebibytes = Math.ceil(bytes / 1024 ** 2 - 1e-9);
  if (mebibytes < 1) {
    throw new ResourceQuantityError(
      `Memory must be at least 1Mi, not "${quantity}"`,
    );
  }
  return mebibytes;
}

export function formatCpu(millicores: number): string {
  return millicores % 1000 === 0 ? `${millicores / 1000}` : `${millicores}m`;
}

export function formatMemory(mebibytes: number): string {
  return mebibytes % 1024 === 0 ? `${mebibytes / 1024}Gi` : `${mebibytes}Mi`;
}

export function normalizeCpu(quantity: string): string {
  return formatCpu(cpuMillicoresOf(quantity));
}

export function normalizeMemory(quantity: string): string {
  return formatMemory(memoryMiOf(quantity));
}

export interface ResourcePair {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

export function normalizeResourcePair<T extends ResourcePair>(pair: T): T {
  const side = (values?: { cpu?: string; memory?: string }) =>
    values && {
      ...values,
      ...(values.cpu !== undefined && { cpu: normalizeCpu(values.cpu) }),
      ...(values.memory !== undefined && {
        memory: normalizeMemory(values.memory),
      }),
    };
  return { ...pair, requests: side(pair.requests), limits: side(pair.limits) };
}

export function limitBelowRequest(pair: ResourcePair): string | null {
  const cpuRequest = pair.requests?.cpu;
  const cpuLimit = pair.limits?.cpu;
  if (cpuRequest && cpuLimit) {
    if (cpuMillicoresOf(cpuLimit) < cpuMillicoresOf(cpuRequest)) {
      return `The CPU limit (${cpuLimit}) is below the CPU request (${cpuRequest}): the limit must be at least the request`;
    }
  }
  const memoryRequest = pair.requests?.memory;
  const memoryLimit = pair.limits?.memory;
  if (memoryRequest && memoryLimit) {
    if (memoryMiOf(memoryLimit) < memoryMiOf(memoryRequest)) {
      return `The memory limit (${memoryLimit}) is below the memory request (${memoryRequest}): the limit must be at least the request`;
    }
  }
  return null;
}
