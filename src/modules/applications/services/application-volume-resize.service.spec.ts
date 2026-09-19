const mockPatch = jest.fn();
const mockReadPvc = jest.fn();
const mockListStorageClass = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  StorageV1Api: 'StorageV1Api',
  CoreV1Api: 'CoreV1Api',
  PatchStrategy: { MergePatch: 'MergePatch' },
  KubernetesObjectApi: { makeApiClient: () => ({ patch: mockPatch }) },
}));

import { ApplicationVolumeResizeService } from './application-volume-resize.service';

/**
 * The claim shapes these tests use mirror what `ApplicationVolumeClaimsService`
 * really returns, because the whole decision here turns on two of its fields:
 * the storage class and the size already asked for.
 */
const claim = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'data-postgres-0',
  namespace: 'user-demo',
  requested: '5Gi',
  requestedBytes: 5 * 1024 * 1024 * 1024,
  storageClass: 'csi-block',
  phase: 'Bound',
  attributedBy: 'label',
  ...over,
});

const build = (opts: {
  classes: Array<{ name: string; allowVolumeExpansion?: boolean }>;
  claims?: ReturnType<typeof claim>[];
  pendingCondition?: boolean;
  /** What `status.capacity` reports after the patch. */
  observedCapacity?: string;
}) => {
  mockPatch.mockReset();
  mockListStorageClass.mockReset();
  mockReadPvc.mockReset();

  mockListStorageClass.mockResolvedValue({
    items: opts.classes.map((c) => ({
      metadata: { name: c.name },
      allowVolumeExpansion: c.allowVolumeExpansion,
    })),
  });
  mockReadPvc.mockResolvedValue({
    status: {
      capacity: { storage: opts.observedCapacity ?? '20Gi' },
      conditions: opts.pendingCondition
        ? [{ type: 'FileSystemResizePending', status: 'True' }]
        : [],
    },
  });

  const kubernetesService = {
    makeKubeConfig: () => ({
      makeApiClient: (api: string) =>
        api === 'StorageV1Api'
          ? { listStorageClass: mockListStorageClass }
          : { readNamespacedPersistentVolumeClaim: mockReadPvc },
    }),
  };

  const service = new ApplicationVolumeResizeService(
    {
      findOne: async () => ({ id: 'c1', kubeconfigEncrypted: 'sealed' }),
    } as never,
    {
      findById: async () => ({
        id: 'app-1',
        slug: 'shop',
        clusterId: 'c1',
        k8sNamespace: 'user-demo',
      }),
    } as never,
    { findByApplicationId: async () => [] } as never,
    {
      resolveForApplication: async () => opts.claims ?? [claim()],
    } as never,
    kubernetesService as never,
    { decrypt: () => 'kubeconfig' } as never,
  );

  return service;
};

describe('growing one application volume', () => {
  it('grows a volume whose class allows it, and says the space is usable', async () => {
    const service = build({
      classes: [{ name: 'csi-block', allowVolumeExpansion: true }],
    });

    const result = await service.resize('app-1', 'data-postgres-0', 20);

    expect(result.from).toBe('5Gi');
    expect(result.to).toBe('20Gi');
    expect(result.outcome).toBe('applied');
    expect(result.restartRequired).toBe(false);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch.mock.calls[0][0]).toMatchObject({
      kind: 'PersistentVolumeClaim',
      spec: { resources: { requests: { storage: '20Gi' } } },
    });
  });

  /**
   * The case that matters most, because it is the one every Flui cluster hits
   * today: both default classes are local-path and neither allows expansion.
   * A product that answered "done" here would be lying — local-path does not
   * even enforce the size it was given.
   */
  it('refuses on a class that cannot expand, and explains why in plain words', async () => {
    const service = build({
      classes: [{ name: 'flui-local' }],
      claims: [claim({ storageClass: 'flui-local' })],
    });

    await expect(
      service.resize('app-1', 'data-postgres-0', 20),
    ).rejects.toThrow(/cannot be resized/);
    await expect(
      service.resize('app-1', 'data-postgres-0', 20),
    ).rejects.toThrow(/not a limit/);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('warns when the extra space only appears after a restart', async () => {
    const service = build({
      classes: [{ name: 'csi-block', allowVolumeExpansion: true }],
      pendingCondition: true,
    });

    const result = await service.resize('app-1', 'data-postgres-0', 20);

    expect(result.restartRequired).toBe(true);
    expect(result.message).toContain('restarts');
  });

  it('never shrinks, and says so in terms of the data', async () => {
    const service = build({
      classes: [{ name: 'csi-block', allowVolumeExpansion: true }],
    });

    await expect(service.resize('app-1', 'data-postgres-0', 2)).rejects.toThrow(
      /only grow, never shrink/,
    );
    expect(mockPatch).not.toHaveBeenCalled();
  });

  /**
   * A class that declares `allowVolumeExpansion` can still take 1Gi → 3Gi into
   * `spec` and leave `status.capacity` at 1Gi for good, because nothing behind
   * it can actually resize. Success is read from capacity, never from the
   * absence of a condition.
   */
  it('does not claim success while the storage has not caught up', async () => {
    const service = build({
      classes: [{ name: 'csi-block', allowVolumeExpansion: true }],
      observedCapacity: '5Gi',
    });

    const result = await service.resize('app-1', 'data-postgres-0', 20);

    expect(result.outcome).toBe('in-progress');
    expect(result.message).toContain('cannot actually grow');
  });

  /**
   * The API server's own words: "spec is immutable after creation except
   * resources.requests ... for bound claims". Before this check the caller got
   * a bare 500 for a volume nothing had used yet.
   */
  it('refuses a volume the application has not started using', async () => {
    const service = build({
      classes: [{ name: 'csi-block', allowVolumeExpansion: true }],
      claims: [claim({ phase: 'Pending' })],
    });

    await expect(
      service.resize('app-1', 'data-postgres-0', 20),
    ).rejects.toThrow(/not in use yet/);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('refuses a volume this application does not own', async () => {
    const service = build({
      classes: [{ name: 'csi-block', allowVolumeExpansion: true }],
    });

    await expect(
      service.resize('app-1', 'somebody-elses-volume', 20),
    ).rejects.toThrow(/no volume named/);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('refuses when the class vanished from the cluster', async () => {
    const service = build({ classes: [] });

    await expect(
      service.resize('app-1', 'data-postgres-0', 20),
    ).rejects.toThrow(/no longer exists/);
  });
});

describe('the plan, which changes nothing', () => {
  it('marks each volume as growable or not, and never patches', async () => {
    const service = build({
      classes: [
        { name: 'csi-block', allowVolumeExpansion: true },
        { name: 'flui-local' },
      ],
      claims: [
        claim(),
        claim({ name: 'data-redis-0', storageClass: 'flui-local' }),
      ],
    });

    const plan = await service.planForApplication('app-1');

    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      volumeName: 'data-postgres-0',
      canGrow: true,
    });
    expect(plan[1]).toMatchObject({
      volumeName: 'data-redis-0',
      canGrow: false,
    });
    expect(plan[1].reason).toContain('cannot be resized');
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
