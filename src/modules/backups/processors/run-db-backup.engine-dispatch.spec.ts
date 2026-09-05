// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; the processor reaches it only through services that are stubbed here.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { RunDbBackupProcessor } from './run-db-backup.processor';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';

/**
 * The database-class backup path used to be pgBackRest with extra steps.
 *
 * Every test here is about the moment a second engine exists: enabling
 * continuous backup on a MariaDB wrote a policy row and then ran pgBackRest
 * inside a MariaDB container, so the command succeeded and the first job
 * failed minutes later — a row asserting protection that was never set up.
 * What has to hold now is that the tool comes from the policy, the artifact
 * carries what a restore of THAT engine will need, and neither is a default.
 */
describe('RunDbBackupProcessor engine dispatch', () => {
  function engine(name: string, extra: Record<string, any> = {}): any {
    return {
      engine: name,
      catalogSlug: name,
      restoreEnvPrefix: `FLUI_${name.toUpperCase()}_`,
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
        engineVersion: '11.3.2',
        tool: `${name}-tool`,
        catalogSlug: name,
        identities: { user: 'appuser', database: 'appdb' },
      })),
      artifactObjectPrefix: jest.fn((appId: string) => `${name}/${appId}/`),
      ...extra,
    };
  }

  function make(policyEngine: string | undefined, chosen: any) {
    const saved: any[] = [];
    const locations: any[] = [];
    const artifactRepo = {
      createArtifact: jest.fn((a: any) => a),
      saveArtifact: jest.fn(async (a: any) => {
        saved.push(a);
        return { ...a, id: 'art-1' };
      }),
      saveLocation: jest.fn(async (l: any) => {
        locations.push(l);
        return l;
      }),
    };
    const registry = { forEngine: jest.fn(() => chosen) };
    const processor = new RunDbBackupProcessor(
      { update: jest.fn(async () => ({})) } as any,
      {
        findById: jest.fn(async () => ({
          id: 'job-1',
          policyId: 'pol-1',
          clusterId: 'cl-1',
        })),
        update: jest.fn(async () => ({})),
      } as any,
      {
        findById: jest.fn(async () => ({
          id: 'pol-1',
          engine: policyEngine,
          engineClass: BackupEngineClass.DATABASE,
          scopeSelector: { applicationIds: ['app-1'] },
          retentionMaxCopies: 2,
          metadata: {},
        })),
        primaryDestinationOf: jest.fn(() => ({ destinationId: 'dest-1' })),
      } as any,
      { findById: jest.fn(async () => ({ id: 'dest-1' })) } as any,
      artifactRepo as any,
      registry as any,
    );
    return { processor, registry, saved, locations };
  }

  it('runs the engine the policy recorded, and asks the registry by that name', async () => {
    const mariadb = engine('mariadb');
    const { processor, registry } = make('mariadb', mariadb);

    await processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);

    expect(registry.forEngine).toHaveBeenCalledWith('mariadb');
    expect(mariadb.enable).toHaveBeenCalled();
    expect(mariadb.baseBackup).toHaveBeenCalled();
  });

  it('takes a full when the engine has no opinion about backup types', async () => {
    // MariaDB has one kind of base backup. Answering `full` is a fact about
    // the engine, and the processor must not invent an incremental chain for
    // something that cannot produce one.
    const mariadb = engine('mariadb');
    const { processor } = make('mariadb', mariadb);

    await processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);

    expect(mariadb.baseBackup).toHaveBeenCalledWith('app-1', 'full');
  });

  it('lets an engine that has a chain choose its own type', async () => {
    const pg = engine('postgres', {
      chooseBackupType: jest.fn(async () => 'incr'),
    });
    const { processor } = make('postgres', pg);

    await processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);

    expect(pg.chooseBackupType).toHaveBeenCalledWith('app-1', 7);
    expect(pg.baseBackup).toHaveBeenCalledWith('app-1', 'incr');
  });

  it('writes the identities a restore needs when the source is gone', async () => {
    // The artifact is read on the day the application, and possibly its
    // cluster, no longer exists. Anything the restore would have to look up
    // elsewhere is something it may not find.
    const mariadb = engine('mariadb');
    const { processor, saved } = make('mariadb', mariadb);

    await processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);

    expect(saved[0].manifestSummary.identities).toEqual({
      user: 'appuser',
      database: 'appdb',
    });
    expect(saved[0].engine).toBe('mariadb');
    expect(saved[0].engineVersion).toBe('11.3.2');
    // Never under Postgres's spelling: a MariaDB user recorded as `pgUser`
    // would be a wrong entry in the row a recovery reads.
    expect(saved[0].manifestSummary.pgUser).toBeUndefined();
  });

  it('keeps the old Postgres key names beside the new ones', async () => {
    // Artifacts written before engines existed carried `pgUser`/`pgDb`, and a
    // reader that has not been upgraded still looks for them.
    const pg = engine('postgres');
    const { processor, saved } = make('postgres', pg);

    await processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);

    expect(saved[0].manifestSummary.pgUser).toBe('appuser');
    expect(saved[0].manifestSummary.pgDb).toBe('appdb');
    expect(saved[0].manifestSummary.identities).toEqual({
      user: 'appuser',
      database: 'appdb',
    });
  });

  it('points the artifact location at the engine’s own prefix', async () => {
    // A location under another engine's prefix makes retention list an empty
    // path and report a backup that exists as missing.
    const mariadb = engine('mariadb');
    const { processor, locations } = make('mariadb', mariadb);

    await processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);

    expect(locations[0].objectKeyPrefix).toBe('mariadb/app-1/');
  });
});
