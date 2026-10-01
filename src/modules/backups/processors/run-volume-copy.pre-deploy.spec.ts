jest.mock('@kubernetes/client-node', () => ({}));

import { RunVolumeCopyProcessor } from './run-volume-copy.processor';

function build(triggerType: string, copyFails = false) {
  const createForApp = jest.fn(async () => {
    if (copyFails) throw new Error('boom');
    return {};
  });
  const replication = { afterRun: jest.fn(async () => 1) };
  const policy = {
    id: 'p1',
    userId: 'u1',
    scopeSelector: { applicationIds: ['a1'] },
    destinations: [
      { destinationId: 'd1', role: 'primary' },
      { destinationId: 'd2', role: 'replica' },
    ],
    metadata: {},
  };
  const processor = new RunVolumeCopyProcessor(
    {
      findById: jest.fn(async (id: string) => ({
        id,
        policyId: 'p1',
        triggerType,
      })),
      update: jest.fn(),
    } as never,
    { findById: async () => policy } as never,
    { findById: async (id: string) => ({ id }) } as never,
    {
      findById: async (id: string) => ({
        id,
        slug: 'shop',
        clusterId: 'c1',
        k8sNamespace: 'shop',
      }),
    } as never,
    { createForApp } as never,
    { resolveForApplication: async () => [{ name: 'data' }] } as never,
    { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) } as never,
    { decrypt: () => 'kubeconfig' } as never,
    replication as never,
  );
  return { processor, createForApp, replication, policy };
}

describe('RunVolumeCopyProcessor — before a deploy, and after every run', () => {
  it('takes a copy before a deploy under its own trigger', async () => {
    const { processor, createForApp } = build('pre_deploy');
    await processor.handle({ data: { backupJobId: 'job-1' } } as never);
    expect(createForApp).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'pre-deploy',
        description: 'pre-deploy',
      }),
    );
  });

  it("mirrors the application's repository to the replica once something was copied", async () => {
    const { processor, replication, policy } = build('scheduled');
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as never;
    }) as never);
    await processor.handle({ data: { backupJobId: 'job-1' } } as never);
    expect(replication.afterRun).toHaveBeenCalledWith({
      policy,
      applicationId: 'a1',
      backupJobId: 'job-1',
      primaryDestinationId: 'd1',
    });
    jest.restoreAllMocks();
  });

  it('mirrors nothing when nothing was copied', async () => {
    const { processor, replication } = build('on_demand', true);
    await processor.handle({ data: { backupJobId: 'job-1' } } as never);
    expect(replication.afterRun).not.toHaveBeenCalled();
  });
});
