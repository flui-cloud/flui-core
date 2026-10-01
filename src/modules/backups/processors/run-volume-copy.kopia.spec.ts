jest.mock('@kubernetes/client-node', () => ({}));

import { RunVolumeCopyProcessor } from './run-volume-copy.processor';
import { BackupJobStatus } from '../enums/backup-job.enum';

describe('RunVolumeCopyProcessor — scheduled copies are kopia snapshots of the policy', () => {
  it('passes the policy retention and its own run job for every volume', async () => {
    const createForApp = jest.fn(async () => ({}));
    const jobsService = {
      findById: jest.fn(async (id: string) => ({
        id,
        policyId: 'p1',
        triggerType: 'on_demand',
      })),
      update: jest.fn(),
    };
    const processor = new RunVolumeCopyProcessor(
      jobsService as never,
      {
        findById: async () => ({
          id: 'p1',
          userId: 'u1',
          scopeSelector: { applicationIds: ['a1'] },
          destinations: [{ destinationId: 'd1', role: 'primary' }],
          metadata: { keepMonthly: true },
        }),
      } as never,
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
      {
        resolveForApplication: async () => [
          { name: 'data' },
          { name: 'uploads' },
        ],
      } as never,
      { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) } as never,
      { decrypt: () => 'kubeconfig' } as never,
    );

    await processor.handle({ data: { backupJobId: 'job-1' } } as never);

    expect(createForApp).toHaveBeenCalledTimes(2);
    for (const [call] of createForApp.mock.calls as any[]) {
      expect(call).toMatchObject({
        destinationId: 'd1',
        policyId: 'p1',
        backupJobId: 'job-1',
        retention: {
          keepLatest: 1,
          keepDaily: 7,
          keepWeekly: 4,
          keepMonthly: 3,
        },
      });
    }
    expect(jobsService.update.mock.calls.at(-1)[1].status).toBe(
      BackupJobStatus.COMPLETED,
    );
  });
});
