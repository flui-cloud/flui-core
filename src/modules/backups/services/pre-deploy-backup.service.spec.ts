jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import {
  NothingToBackUpBeforeDeploy,
  PreDeployBackupService,
} from './pre-deploy-backup.service';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import {
  BackupJobStatus,
  BackupJobTriggerType,
} from '../enums/backup-job.enum';

const APP = {
  id: 'a1',
  slug: 'shop',
  clusterId: 'c1',
  preDeploySnapshotEnabled: false,
  preDeploySnapshotPolicy: 'best_effort',
};

const dbPolicy = (engine: string) => ({
  id: 'p-db',
  userId: 'u1',
  engine,
  engineClass: BackupEngineClass.DATABASE,
  scopeSelector: { applicationIds: ['a1'] },
  enabled: true,
  status: BackupPolicyStatus.ACTIVE,
});
const copyPolicy = {
  id: 'p-vc',
  userId: 'u1',
  engineClass: BackupEngineClass.VOLUME_COPY,
  scopeSelector: { applicationIds: ['a1'] },
  enabled: true,
  status: BackupPolicyStatus.ACTIVE,
};

function build(policies: any[]) {
  const mark = jest.fn(async () => ({
    at: '2026-10-01T10:00:00.000Z',
    position: '0/3000090',
  }));
  const engines: Record<string, any> = {
    postgres: { engine: 'postgres', markRestorePoint: mark },
    'postgres-dump': { engine: 'postgres-dump', pointInTime: false },
  };
  const jobRows = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'job-rp', ...x })),
  };
  const artifacts = {
    createArtifact: jest.fn((x) => x),
    saveArtifact: jest.fn(async (x) => ({ id: 'art-rp', ...x })),
  };
  const jobs = {
    createOnDemand: jest.fn(async (_u: string, dto: any, _t?: string) => ({
      id: `job-${dto.policyId}`,
    })),
  };
  const apps = {
    findOne: jest.fn(async () => ({ ...APP })),
    update: jest.fn(async () => undefined),
  };
  const service = new PreDeployBackupService(
    apps as any,
    { findByCluster: jest.fn(async () => policies) } as any,
    jobRows as any,
    artifacts as any,
    jobs as any,
    {
      forEngine: (e: string) => engines[e],
      supports: (e: string) => e in engines,
    } as any,
  );
  return { service, mark, jobRows, artifacts, jobs, apps };
}

describe('the backup taken before a deploy', () => {
  it('records a restore point of a continuous database as a run and a row that is not a base', async () => {
    const { service, mark, jobRows, artifacts, jobs } = build([
      dbPolicy('postgres'),
      copyPolicy,
    ]);
    const result = await service.run({ applicationId: 'a1', deployId: 'op-9' });

    expect(mark).toHaveBeenCalledWith('a1', 'op-9');
    expect(jobRows.save).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: BackupJobTriggerType.PRE_DEPLOY,
        status: BackupJobStatus.COMPLETED,
        applicationId: 'a1',
      }),
    );
    expect(jobRows.save.mock.calls[0][0].policyId).toBeUndefined();
    const artifact = artifacts.saveArtifact.mock.calls[0][0];
    expect(artifact.applicationId).toBeUndefined();
    expect(artifact.manifestSummary.applicationId).toBeUndefined();
    expect(artifact.manifestSummary).toMatchObject({
      kind: 'restore-point',
      restorePointFor: 'a1',
      recoverTo: '2026-10-01T10:00:00.000Z',
      position: '0/3000090',
    });
    expect(result.restorePoint).toEqual({
      artifactId: 'art-rp',
      at: '2026-10-01T10:00:00.000Z',
      position: '0/3000090',
      engine: 'postgres',
    });

    // The copy of the other volumes is started, and not waited for.
    expect(jobs.createOnDemand).toHaveBeenCalledWith(
      'u1',
      { policyId: 'p-vc', metadata: { deployId: 'op-9', applicationId: 'a1' } },
      BackupJobTriggerType.PRE_DEPLOY,
    );
    expect(result.volumeJobId).toBe('job-p-vc');
  });

  it('starts a dump for a database kept by dumps', async () => {
    const { service, mark, jobs } = build([dbPolicy('postgres-dump')]);
    const result = await service.run({ applicationId: 'a1', deployId: 'op-9' });
    expect(mark).not.toHaveBeenCalled();
    expect(result.dumpJobId).toBe('job-p-db');
    expect(jobs.createOnDemand.mock.calls[0][2]).toBe(
      BackupJobTriggerType.PRE_DEPLOY,
    );
  });

  it('says so when nothing protects the application', async () => {
    const { service } = build([]);
    await expect(
      service.run({ applicationId: 'a1', deployId: 'op-9' }),
    ).rejects.toBeInstanceOf(NothingToBackUpBeforeDeploy);
  });

  it('turns the option on, says what it will take, and warns when nothing would be', async () => {
    const on = build([dbPolicy('postgres'), copyPolicy]);
    const option = await on.service.setOption('a1', {
      enabled: true,
      required: true,
    });
    expect(on.apps.update).toHaveBeenCalledWith('a1', {
      preDeploySnapshotEnabled: true,
      preDeploySnapshotPolicy: 'required',
    });
    expect(option).toEqual({
      applicationId: 'a1',
      enabled: true,
      required: true,
      takes: { restorePoint: true, dump: false, volumes: true },
    });

    const bare = build([]);
    const warned = await bare.service.setOption('a1', { enabled: true });
    expect(warned.warning).toContain('No backup policy protects');
    expect(warned.required).toBe(false);
  });
});
