import {
  SANDBOX_LIMIT_RANGE_NAME,
  SANDBOX_QUOTA_NAME,
} from '../../shared/utils/quota-refusal.util';

/**
 * What one guest may consume. Deliberately small: the demo has to prove that a
 * real application runs, not that the instance is generous. The numbers are the
 * capacity dial for how many guests fit on a node — F3 measures the instance
 * against them rather than the other way round.
 */
export interface SandboxQuota {
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  storage: string;
  /**
   * Bytes a tenancy may actually write to the node's own disk.
   *
   * Deliberately not `storage`, which does a different job: that one is summed
   * from the sizes *declared* on claims and so governs how many applications a
   * guest may install — the catalogue asks for 10Gi for a code editor and 2Gi
   * for a note-taker, none of which is what they go on to use. This is the
   * ceiling the kernel enforces on bytes written, and a trial that lasts a day
   * needs far less of it than the declared sums suggest.
   */
  nodeLocalCeiling: string;
  /**
   * Bytes a container may write outside a volume — its writable layer, its logs
   * and any emptyDir. Unlike the size declared on a volume, which local-path
   * does not enforce, this one the kubelet does enforce: it evicts the pod that
   * exceeds it. It is the only byte ceiling in this file that is real.
   */
  ephemeralStorageRequest: string;
  ephemeralStorageLimit: string;
  pods: number;
  services: number;
  persistentVolumeClaims: number;
  /** Applied to any container that declares nothing of its own. */
  defaultContainerCpu: string;
  defaultContainerMemory: string;
  defaultContainerEphemeralStorage: string;
  maxContainerCpu: string;
  maxContainerMemory: string;
  maxContainerEphemeralStorage: string;
}

/**
 * Measured, not guessed. The seeded application asks for 500m/512Mi of requests
 * across its four components and 7Gi of volumes; the rest is headroom for what
 * the guest installs on top. Requests are what decide how many tenancies fit on
 * a node — limits only cap a runaway one.
 */
export const DEFAULT_SANDBOX_QUOTA: SandboxQuota = {
  cpuRequest: '1500m',
  cpuLimit: '2',
  memoryRequest: '2Gi',
  memoryLimit: '6Gi',
  storage: '12Gi',
  nodeLocalCeiling: '2Gi',
  ephemeralStorageRequest: '4Gi',
  ephemeralStorageLimit: '8Gi',
  pods: 12,
  services: 12,
  persistentVolumeClaims: 8,
  defaultContainerCpu: '200m',
  defaultContainerMemory: '256Mi',
  defaultContainerEphemeralStorage: '1Gi',
  maxContainerCpu: '1',
  maxContainerMemory: '1Gi',
  maxContainerEphemeralStorage: '4Gi',
};

const QUANTITY = /^\d+(\.\d+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$/;

/** The environment variable that overrides each field of the guest quota. */
export const SANDBOX_QUOTA_ENV: Record<keyof SandboxQuota, string> = {
  cpuRequest: 'SANDBOX_QUOTA_CPU_REQUEST',
  cpuLimit: 'SANDBOX_QUOTA_CPU_LIMIT',
  memoryRequest: 'SANDBOX_QUOTA_MEMORY_REQUEST',
  memoryLimit: 'SANDBOX_QUOTA_MEMORY_LIMIT',
  storage: 'SANDBOX_QUOTA_STORAGE',
  nodeLocalCeiling: 'SANDBOX_QUOTA_NODE_DISK',
  ephemeralStorageRequest: 'SANDBOX_QUOTA_EPHEMERAL_REQUEST',
  ephemeralStorageLimit: 'SANDBOX_QUOTA_EPHEMERAL_LIMIT',
  pods: 'SANDBOX_QUOTA_PODS',
  services: 'SANDBOX_QUOTA_SERVICES',
  persistentVolumeClaims: 'SANDBOX_QUOTA_VOLUMES',
  defaultContainerCpu: 'SANDBOX_QUOTA_CONTAINER_DEFAULT_CPU',
  defaultContainerMemory: 'SANDBOX_QUOTA_CONTAINER_DEFAULT_MEMORY',
  defaultContainerEphemeralStorage: 'SANDBOX_QUOTA_CONTAINER_DEFAULT_EPHEMERAL',
  maxContainerCpu: 'SANDBOX_QUOTA_CONTAINER_MAX_CPU',
  maxContainerMemory: 'SANDBOX_QUOTA_CONTAINER_MAX_MEMORY',
  maxContainerEphemeralStorage: 'SANDBOX_QUOTA_CONTAINER_MAX_EPHEMERAL',
};

/**
 * The guest quota, field by field from the environment. A value that is not a
 * valid quantity keeps the default: a typo must not turn a ceiling into none.
 */
export function loadSandboxQuota(
  env: NodeJS.ProcessEnv = process.env,
): SandboxQuota {
  const quota = { ...DEFAULT_SANDBOX_QUOTA };
  for (const key of Object.keys(SANDBOX_QUOTA_ENV) as (keyof SandboxQuota)[]) {
    const raw = env[SANDBOX_QUOTA_ENV[key]]?.trim();
    if (!raw || !QUANTITY.test(raw)) continue;
    const fallback = DEFAULT_SANDBOX_QUOTA[key];
    if (typeof fallback === 'number') {
      const count = Number(raw);
      if (Number.isInteger(count) && count >= 0) {
        (quota as Record<string, string | number>)[key] = count;
      }
    } else {
      (quota as Record<string, string | number>)[key] = raw;
    }
  }
  return quota;
}

/**
 * A ResourceQuota caps the tenancy; a LimitRange gives every container a ceiling
 * and a floor. Both are needed: without the LimitRange a single pod with no
 * limits of its own would swallow the whole quota, and a pod with no requests at
 * all would be admitted against a quota that counts requests.
 */
export function buildSandboxQuotaManifests(
  namespace: string,
  quota: SandboxQuota = DEFAULT_SANDBOX_QUOTA,
): string {
  return `apiVersion: v1
kind: ResourceQuota
metadata:
  name: ${SANDBOX_QUOTA_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: flui
    flui.cloud/sandbox: "true"
spec:
  hard:
    requests.cpu: "${quota.cpuRequest}"
    limits.cpu: "${quota.cpuLimit}"
    requests.memory: "${quota.memoryRequest}"
    limits.memory: "${quota.memoryLimit}"
    requests.storage: "${quota.storage}"
    requests.ephemeral-storage: "${quota.ephemeralStorageRequest}"
    limits.ephemeral-storage: "${quota.ephemeralStorageLimit}"
    pods: "${quota.pods}"
    services: "${quota.services}"
    persistentvolumeclaims: "${quota.persistentVolumeClaims}"
    services.nodeports: "0"
    services.loadbalancers: "0"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: ${SANDBOX_LIMIT_RANGE_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: flui
    flui.cloud/sandbox: "true"
spec:
  limits:
    - type: Container
      default:
        cpu: "${quota.defaultContainerCpu}"
        memory: "${quota.defaultContainerMemory}"
        ephemeral-storage: "${quota.defaultContainerEphemeralStorage}"
      defaultRequest:
        cpu: "${quota.defaultContainerCpu}"
        memory: "${quota.defaultContainerMemory}"
        ephemeral-storage: "${quota.defaultContainerEphemeralStorage}"
      max:
        cpu: "${quota.maxContainerCpu}"
        memory: "${quota.maxContainerMemory}"
        ephemeral-storage: "${quota.maxContainerEphemeralStorage}"
    - type: PersistentVolumeClaim
      max:
        storage: "${quota.storage}"
`;
}
