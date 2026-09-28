jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { ReplicateBackupProcessor } from './replicate-backup.processor';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupJobStatus } from '../enums/backup-job.enum';

/**
 * The run's outcome is written through the jobs service, the one place that
 * raises or clears the backup alert and measures the destination afterwards.
 * A status written past it is a failure nobody is told about.
 */
describe('ReplicateBackupProcessor — the job outcome', () => {
  function build(locations: Array<{ state: ArtifactLocationState }>) {
    const jobRepo = { update: jest.fn(), findById: jest.fn() };
    const jobsService = { update: jest.fn() };
    const processor = new ReplicateBackupProcessor(
      { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) } as never,
      {
        updateLocation: jest.fn(),
        findArtifact: async () => ({
          backupJobId: 'job-1',
          locations,
          manifestSummary: {},
        }),
      } as never,
      { findById: async (id: string) => ({ id, metadata: {} }) } as never,
      jobRepo as never,
      { update: jest.fn() } as never,
      {
        toCredentials: () => ({
          bucket: 'b',
          endpoint: 'https://s3',
          region: 'r',
          accessKey: 'a',
          secretKey: 's',
          provider: 'generic_s3',
        }),
      } as never,
      { decrypt: (v: string) => v } as never,
      {
        applyManifest: jest.fn(),
        getResource: async () => ({ status: { succeeded: 1 } }),
      } as never,
      { render: () => 'kind: Job' } as never,
      jobsService as never,
    );
    return { processor, jobRepo, jobsService };
  }

  const job = {
    data: {
      artifactId: 'artifact-1234',
      locationId: 'loc-1',
      sourceDestinationId: 'd1',
      targetDestinationId: 'd2',
      veleroBackupName: 'b1',
    },
  } as never;

  it('completes the job through the jobs service once every copy has landed', async () => {
    const { processor, jobRepo, jobsService } = build([
      { state: ArtifactLocationState.AVAILABLE },
      { state: ArtifactLocationState.AVAILABLE },
    ]);
    await processor.handle(job);
    expect(jobsService.update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: BackupJobStatus.COMPLETED }),
    );
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('reports a partial job the same way when a copy failed', async () => {
    const { processor, jobsService } = build([
      { state: ArtifactLocationState.AVAILABLE },
      { state: ArtifactLocationState.FAILED },
    ]);
    await processor.handle(job);
    expect(jobsService.update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        status: BackupJobStatus.PARTIALLY_COMPLETED,
      }),
    );
  });
});
