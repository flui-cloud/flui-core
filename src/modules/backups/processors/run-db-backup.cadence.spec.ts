jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { RunDbBackupProcessor } from './run-db-backup.processor';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import {
  BackupJobStatus,
  BackupJobTriggerType,
} from '../enums/backup-job.enum';

function engine(name: string, extra: Record<string, any> = {}): any {
  return {
    engine: name,
    catalogSlug: name,
    enable: jest.fn(async () => undefined),
    baseBackup: jest.fn(async () => `${name}-label`),
    info: jest.fn(async () => ({
      latestLabel: `${name}-label`,
      oldestRecoverable: '2026-01-01T00:00:00Z',
      newestRecoverable: '2026-01-02T00:00:00Z',
      backupCount: 1,
    })),
    describeForArtifact: jest.fn(async () => ({
      engine: name,
      tool: `${name}-tool`,
      catalogSlug: name,
      identities: { user: 'u', database: 'd' },
      compression: { type: 'zstd', level: 3, logs: 'zstd' },
    })),
    artifactObjectPrefix: jest.fn((appId: string) => `${name}/${appId}/`),
    ...extra,
  };
}

function make(
  chosen: any,
  opts: {
    triggerType?: BackupJobTriggerType;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const saved: any[] = [];
  const jobUpdates: any[] = [];
  const processor = new RunDbBackupProcessor(
    { update: jest.fn(async () => ({})) } as any,
    {
      findById: jest.fn(async () => ({
        id: 'job-1',
        policyId: 'pol-1',
        clusterId: 'cl-1',
        triggerType: opts.triggerType ?? BackupJobTriggerType.SCHEDULED,
      })),
      update: jest.fn(async (_id: string, patch: any) => {
        jobUpdates.push(patch);
        return {};
      }),
    } as any,
    {
      findById: jest.fn(async () => ({
        id: 'pol-1',
        engine: chosen.engine,
        engineClass: BackupEngineClass.DATABASE,
        scopeSelector: { applicationIds: ['app-1'] },
        retentionMaxCopies: 2,
        metadata: { fullEveryDays: 7, ...opts.metadata },
      })),
      primaryDestinationOf: jest.fn(() => ({ destinationId: 'dest-1' })),
    } as any,
    { findById: jest.fn(async () => ({ id: 'dest-1' })) } as any,
    {
      createArtifact: jest.fn((a: any) => a),
      saveArtifact: jest.fn(async (a: any) => {
        saved.push(a);
        return { ...a, id: 'art-1' };
      }),
      saveLocation: jest.fn(async (l: any) => l),
    } as any,
    { forEngine: jest.fn(() => chosen) } as any,
  );
  const run = () =>
    processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);
  return { run, saved, jobUpdates };
}

describe('RunDbBackupProcessor base cadence', () => {
  const notDue = {
    lastBaseAt: '2026-09-28T02:00:00.000Z',
    dueAt: '2026-10-05T02:00:00.000Z',
  };

  it('completes a scheduled run without a base while the last one is recent', async () => {
    const mariadb = engine('mariadb', {
      baseNotDue: jest.fn(async () => notDue),
    });
    const { run, saved, jobUpdates } = make(mariadb);

    await run();

    expect(mariadb.baseNotDue).toHaveBeenCalledWith('app-1', 7);
    expect(mariadb.enable).toHaveBeenCalled();
    expect(mariadb.baseBackup).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(jobUpdates.at(-1)).toMatchObject({
      status: BackupJobStatus.COMPLETED,
      metadata: {
        baseSkipped: true,
        lastBaseAt: notDue.lastBaseAt,
        nextBaseDueAt: notDue.dueAt,
      },
    });
  });

  it('takes the base when the engine says it is due', async () => {
    const mariadb = engine('mariadb', {
      baseNotDue: jest.fn(async () => null),
    });
    const { run, saved } = make(mariadb);

    await run();

    expect(mariadb.baseBackup).toHaveBeenCalledWith('app-1', 'full');
    expect(saved).toHaveLength(1);
  });

  it('always takes a base someone asked for', async () => {
    const mariadb = engine('mariadb', {
      baseNotDue: jest.fn(async () => notDue),
    });
    const { run, saved } = make(mariadb, {
      triggerType: BackupJobTriggerType.ON_DEMAND,
    });

    await run();

    expect(mariadb.baseNotDue).not.toHaveBeenCalled();
    expect(mariadb.baseBackup).toHaveBeenCalled();
    expect(saved).toHaveLength(1);
  });

  it('records the compression the engine read back on the artifact', async () => {
    const { run, saved } = make(engine('mariadb'));

    await run();

    expect(saved[0].manifestSummary.compression).toEqual({
      type: 'zstd',
      level: 3,
      logs: 'zstd',
    });
  });

  it('passes a policy’s archive interval to the engine, and nothing when it has none', async () => {
    const pg = engine('postgres');
    await make(pg, { metadata: { archiveTimeoutSeconds: 120 } }).run();
    expect(pg.enable.mock.calls[0][2]).toMatchObject({
      archiveTimeoutSeconds: 120,
    });

    const plain = engine('postgres');
    await make(plain).run();
    expect(plain.enable.mock.calls[0][2]).not.toHaveProperty(
      'archiveTimeoutSeconds',
    );
  });
});
