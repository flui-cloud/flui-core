jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { ReplicateBackupProcessor } from './replicate-backup.processor';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';

describe('ReplicateBackupProcessor — a kopia repository', () => {
  function build(succeeded: boolean) {
    const rendered: Array<Record<string, string>> = [];
    const artifactRepo = { updateLocation: jest.fn(), findArtifact: jest.fn() };
    const policyRepo = { update: jest.fn() };
    const processor = new ReplicateBackupProcessor(
      { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) } as never,
      artifactRepo as never,
      {
        findById: async (id: string) => ({
          id,
          pathPrefix: id === 'd1' ? 'flui/prod' : '',
          metadata: {},
        }),
      } as never,
      { findById: async () => ({ id: 'job-1', policyId: 'p1' }) } as never,
      policyRepo as never,
      {
        toCredentials: (d: { id: string }) => ({
          bucket: `bucket-${d.id}`,
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
        getResource: async () => ({
          status: succeeded ? { succeeded: 1 } : { failed: 3 },
        }),
      } as never,
      {
        render: (_t: string, vars: Record<string, string>) => {
          rendered.push(vars);
          return 'kind: Job';
        },
      } as never,
    );
    return { processor, artifactRepo, policyRepo, rendered };
  }

  const job = {
    data: {
      mode: 'kopia-repository',
      applicationId: 'app-1',
      backupJobId: 'job-12345678',
      sourceDestinationId: 'd1',
      targetDestinationId: 'd2',
      locationIds: ['l1', 'l2'],
    },
  } as never;

  it("mirrors the application's kopia prefix and marks this run's replica rows available", async () => {
    const { processor, artifactRepo, rendered } = build(true);
    await processor.handle(job);
    expect(rendered[0]).toMatchObject({
      RCLONE_VERB: 'sync',
      SRC_BUCKET: 'bucket-d1',
      SRC_PREFIX: 'flui/prod/kopia/app-1/',
      DST_BUCKET: 'bucket-d2',
      DST_PREFIX: 'kopia/app-1/',
    });
    for (const id of ['l1', 'l2']) {
      expect(artifactRepo.updateLocation).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ state: ArtifactLocationState.AVAILABLE }),
      );
    }
  });

  it('marks the rows failed and the policy degraded when the mirror fails', async () => {
    const { processor, artifactRepo, policyRepo } = build(false);
    await processor.handle(job);
    expect(artifactRepo.updateLocation).toHaveBeenCalledWith(
      'l1',
      expect.objectContaining({ state: ArtifactLocationState.FAILED }),
    );
    expect(policyRepo.update).toHaveBeenCalledWith('p1', {
      status: BackupPolicyStatus.DEGRADED,
    });
  });

  it('drops a replication queued by the removed cluster-backup engine without touching anything', async () => {
    const { processor, artifactRepo, policyRepo, rendered } = build(true);
    await processor.handle({
      data: {
        artifactId: 'a1',
        locationId: 'l1',
        sourceDestinationId: 'd1',
        targetDestinationId: 'd2',
      },
    } as never);
    expect(rendered).toHaveLength(0);
    expect(artifactRepo.updateLocation).not.toHaveBeenCalled();
    expect(policyRepo.update).not.toHaveBeenCalled();
  });
});
