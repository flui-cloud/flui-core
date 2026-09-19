import * as yaml from 'js-yaml';
import {
  buildSandboxQuotaManifests,
  DEFAULT_SANDBOX_QUOTA,
} from './sandbox-quota.manifest';

describe('sandbox quota manifests', () => {
  const docs = (ns = 'user-guest-1') =>
    yaml.loadAll(buildSandboxQuotaManifests(ns)) as Array<Record<string, any>>;

  it('caps the tenancy and every container in it', () => {
    const [quota, limits] = docs();
    expect(quota.kind).toBe('ResourceQuota');
    expect(limits.kind).toBe('LimitRange');
  });

  it('puts both objects in the guest namespace', () => {
    for (const doc of docs('user-someone')) {
      expect(doc.metadata.namespace).toBe('user-someone');
    }
  });

  it('bounds cpu, memory, storage and object counts', () => {
    const [quota] = docs();
    expect(quota.spec.hard['limits.cpu']).toBe(DEFAULT_SANDBOX_QUOTA.cpuLimit);
    expect(quota.spec.hard['limits.memory']).toBe(
      DEFAULT_SANDBOX_QUOTA.memoryLimit,
    );
    expect(quota.spec.hard['requests.storage']).toBe(
      DEFAULT_SANDBOX_QUOTA.storage,
    );
    expect(Number(quota.spec.hard.pods)).toBe(DEFAULT_SANDBOX_QUOTA.pods);
  });

  // A guest that could ask for a NodePort or a LoadBalancer would be opening a
  // port on a machine shared with other guests, outside the ingress and its TLS.
  it('forbids node ports and load balancers outright', () => {
    const [quota] = docs();
    expect(quota.spec.hard['services.nodeports']).toBe('0');
    expect(quota.spec.hard['services.loadbalancers']).toBe('0');
  });

  // Without a default request, a pod that declares nothing is admitted free of
  // charge against a quota that counts requests — the cap would not bind.
  it('gives a container with no resources of its own both a request and a ceiling', () => {
    const [, limits] = docs();
    const container = limits.spec.limits.find(
      (l: { type: string }) => l.type === 'Container',
    );
    expect(container.defaultRequest.cpu).toBe(
      DEFAULT_SANDBOX_QUOTA.defaultContainerCpu,
    );
    expect(container.default.memory).toBe(
      DEFAULT_SANDBOX_QUOTA.defaultContainerMemory,
    );
    expect(container.max.cpu).toBe(DEFAULT_SANDBOX_QUOTA.maxContainerCpu);
  });

  it('never lets one container claim the whole tenancy', () => {
    const [, limits] = docs();
    const container = limits.spec.limits.find(
      (l: { type: string }) => l.type === 'Container',
    );
    expect(container.max.memory).not.toBe(DEFAULT_SANDBOX_QUOTA.memoryLimit);
    expect(container.max.cpu).not.toBe(DEFAULT_SANDBOX_QUOTA.cpuLimit);
  });

  // A catalogue application with several stateful components asks for around
  // 7Gi of volumes, so a 5Gi ceiling stops it silently at the first one.
  it('leaves room for what a guest installs', () => {
    const [quota] = docs();
    expect(parseInt(quota.spec.hard['requests.storage'], 10)).toBeGreaterThan(
      7,
    );
    expect(
      Number(quota.spec.hard.persistentvolumeclaims),
    ).toBeGreaterThanOrEqual(8);
  });

  /**
   * The size declared on a volume is not a cap: a claim of 1Mi accepts 50MiB on
   * both storage classes, and Kubernetes still reports 1Mi. So the storage
   * numbers above bound how much a guest may *ask for*, not how much they may
   * write. Ephemeral storage is the one byte ceiling the kubelet does enforce,
   * and without it a guest fills the node's root filesystem with one `dd`,
   * taking down the cluster rather than merely their own tenancy.
   */
  it('caps the disk a container may fill outside its volumes', () => {
    const [quota, limits] = docs();
    const container = limits.spec.limits.find(
      (l: { type: string }) => l.type === 'Container',
    );

    expect(container.default['ephemeral-storage']).toBe(
      DEFAULT_SANDBOX_QUOTA.defaultContainerEphemeralStorage,
    );
    expect(container.defaultRequest['ephemeral-storage']).toBe(
      DEFAULT_SANDBOX_QUOTA.defaultContainerEphemeralStorage,
    );
    expect(container.max['ephemeral-storage']).toBe(
      DEFAULT_SANDBOX_QUOTA.maxContainerEphemeralStorage,
    );
    expect(quota.spec.hard['limits.ephemeral-storage']).toBe(
      DEFAULT_SANDBOX_QUOTA.ephemeralStorageLimit,
    );
  });

  it('marks what it creates as the platform’s own', () => {
    for (const doc of docs()) {
      expect(doc.metadata.labels['flui.cloud/sandbox']).toBe('true');
      expect(doc.metadata.labels['app.kubernetes.io/managed-by']).toBe('flui');
    }
  });
});
