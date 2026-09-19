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
  cpuLimit: '6',
  memoryRequest: '2Gi',
  memoryLimit: '6Gi',
  storage: '12Gi',
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
