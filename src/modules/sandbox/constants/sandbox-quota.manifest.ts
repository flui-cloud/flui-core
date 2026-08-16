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
  pods: number;
  services: number;
  persistentVolumeClaims: number;
  /** Applied to any container that declares nothing of its own. */
  defaultContainerCpu: string;
  defaultContainerMemory: string;
  maxContainerCpu: string;
  maxContainerMemory: string;
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
  pods: 12,
  services: 12,
  persistentVolumeClaims: 8,
  defaultContainerCpu: '200m',
  defaultContainerMemory: '256Mi',
  maxContainerCpu: '1',
  maxContainerMemory: '1Gi',
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
  name: sandbox-quota
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
    pods: "${quota.pods}"
    services: "${quota.services}"
    persistentvolumeclaims: "${quota.persistentVolumeClaims}"
    services.nodeports: "0"
    services.loadbalancers: "0"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: sandbox-limits
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
      defaultRequest:
        cpu: "${quota.defaultContainerCpu}"
        memory: "${quota.defaultContainerMemory}"
      max:
        cpu: "${quota.maxContainerCpu}"
        memory: "${quota.maxContainerMemory}"
    - type: PersistentVolumeClaim
      max:
        storage: "${quota.storage}"
`;
}
