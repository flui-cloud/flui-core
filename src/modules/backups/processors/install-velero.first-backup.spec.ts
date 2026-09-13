jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { InstallVeleroProcessor } from './install-velero.processor';

/**
 * Velero fails a backup outright, in seconds, when the storage location it
 * names does not exist yet. The first backup of a quick setup therefore cannot
 * run alongside the install that creates that location — it has to follow it.
 */
describe('InstallVeleroProcessor — the first backup', () => {
  const order: string[] = [];

  function build(installSucceeds = true) {
    order.length = 0;
    const createOnDemand = jest.fn(async () => {
      order.push('backup');
      return { id: 'job-1' };
    });
    const processor = new InstallVeleroProcessor(
      {
        findOne: async () => ({ id: 'c1', metadata: {} }),
        update: jest.fn(),
      } as never,
      { update: jest.fn(), save: jest.fn() } as never,
      {
        findById: async (id: string) => ({
          id,
          provider: 'ovh_object_storage',
        }),
      } as never,
      { decrypt: (v: string) => v } as never,
      {
        ensureInstalled: jest.fn(async () => {
          order.push('install');
          if (!installSucceeds) throw new Error('install failed');
        }),
      } as never,
      { createOnDemand } as never,
    );
    return { processor, createOnDemand };
  }

  const job = (data: Record<string, unknown>) => ({ data }) as never;

  it('starts it only after the install that creates its storage location', async () => {
    const { processor, createOnDemand } = build();

    await processor.handle(
      job({
        clusterId: 'c1',
        destinationIds: ['d1'],
        primaryDestinationId: 'd1',
        operationId: 'op1',
        firstBackupPolicyId: 'p1',
        userId: 'u1',
      }),
    );

    expect(createOnDemand).toHaveBeenCalledWith('u1', { policyId: 'p1' });
    expect(order).toEqual(['install', 'backup']);
  });

  it('starts none when the setup did not ask for one', async () => {
    const { processor, createOnDemand } = build();

    await processor.handle(
      job({
        clusterId: 'c1',
        destinationIds: ['d1'],
        primaryDestinationId: 'd1',
        operationId: 'op1',
      }),
    );

    expect(createOnDemand).not.toHaveBeenCalled();
  });

  it('starts none when the install failed, rather than one doomed to fail', async () => {
    const { processor, createOnDemand } = build(false);

    await expect(
      processor.handle(
        job({
          clusterId: 'c1',
          destinationIds: ['d1'],
          primaryDestinationId: 'd1',
          operationId: 'op1',
          firstBackupPolicyId: 'p1',
          userId: 'u1',
        }),
      ),
    ).rejects.toThrow('install failed');

    expect(createOnDemand).not.toHaveBeenCalled();
  });
});
