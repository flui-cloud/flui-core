jest.mock('@kubernetes/client-node', () => ({}));

import { RunVolumeCopyProcessor } from './run-volume-copy.processor';
import { BackupJobStatus } from '../enums/backup-job.enum';

/**
 * A run that stops before it reaches a verdict must still leave one: a job left
 * pending or running is never alerted on and reads as in progress for ever.
 */
describe('RunVolumeCopyProcessor — a run that cannot finish', () => {
  function build(over: { policy?: unknown; cluster?: unknown } = {}) {
    const jobsService = {
      findById: jest.fn(async (id: string) => ({ id, policyId: 'p1' })),
      update: jest.fn(),
    };
    const policy =
      'policy' in over
        ? over.policy
        : {
            id: 'p1',
            userId: 'u1',
            scopeSelector: { applicationIds: ['a1'] },
            destinations: [{ destinationId: 'd1', role: 'primary' }],
          };
    const processor = new RunVolumeCopyProcessor(
      jobsService as never,
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
      {} as never,
      {} as never,
      { findOne: async () => over.cluster ?? null } as never,
      {} as never,
    );
    return { processor, jobsService };
  }

  const job = { data: { backupJobId: 'job-1' } } as never;

  it('fails the job when its policy is gone', async () => {
    const { processor, jobsService } = build({ policy: null });
    await expect(processor.handle(job)).rejects.toThrow('not found');
    expect(jobsService.update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: BackupJobStatus.FAILED,
        errorMessage: 'Policy for job job-1 not found',
      }),
    );
  });

  it('fails the job when the volumes cannot be listed after it started', async () => {
    const { processor, jobsService } = build();
    await expect(processor.handle(job)).rejects.toThrow('no kubeconfig');
    expect(jobsService.update.mock.calls.map((c) => c[1].status)).toEqual([
      BackupJobStatus.RUNNING,
      BackupJobStatus.FAILED,
    ]);
    expect(jobsService.update.mock.calls[1][1].errorMessage).toContain(
      'no kubeconfig',
    );
  });
});
