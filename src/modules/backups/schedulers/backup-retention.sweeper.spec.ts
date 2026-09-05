// The registry pulls in the Kubernetes client, which ships ESM while this
// project's jest transforms only `jose`. Nothing here reaches it: the engine
// lookup is stubbed below.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { BackupRetentionSweeper } from './backup-retention.sweeper';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';

/**
 * Every test here is about a deletion that must NOT happen.
 *
 * The reaper runs unattended against data a user cannot get back, so the value
 * is entirely in its refusals: the pruning itself is one delete call, while a
 * missing refusal is silent data loss discovered on the day of a recovery.
 */
describe('BackupRetentionSweeper', () => {
  function make(
    opts: {
      expired?: any[];
      jobs?: any[];
      siblings?: number;
      inFlightRestores?: number;
      deleteObjects?: jest.Mock;
      listKeys?: string[];
      selfPruningEngines?: string[];
      dbPolicy?: any;
      dbArtifacts?: any[];
      newestDbArtifact?: any;
      engineKeys?: (appId: string, ref: string) => string[];
    } = {},
  ) {
    const deletedArtifacts: string[] = [];
    const artifactRepo = {
      find: jest.fn(async (q: any) =>
        q?.where?.engineClass === 'database'
          ? (opts.dbArtifacts ?? [])
          : (opts.expired ?? []),
      ),
      // A different row by default, so a test is not accidentally exercising
      // the newest-base refusal when it means to exercise something else.
      findOne: jest.fn(async () => opts.newestDbArtifact ?? { id: 'a-newest' }),
      count: jest.fn(async () => opts.siblings ?? 5),
      delete: jest.fn(async (q: any) => {
        deletedArtifacts.push(q.id);
        return {};
      }),
      update: jest.fn(async () => ({})),
    };
    const locationRepo = {
      find: jest.fn(async () => [
        { artifactId: 'a1', destinationId: 'd1', objectKeyPrefix: 'flui/x/' },
      ]),
      delete: jest.fn(async () => ({})),
    };
    const jobRepo = {
      find: jest.fn(async () => opts.jobs ?? [{ id: 'j1', policyId: 'p1' }]),
    };
    const restoreRepo = {
      count: jest.fn(async () => opts.inFlightRestores ?? 0),
    };
    const destRepo = {
      findOne: jest.fn(async () => ({ id: 'd1', provider: 'scaleway' })),
    };
    const destinations = { toCredentials: jest.fn(() => ({})) };
    const deleteObjects = opts.deleteObjects ?? jest.fn(async () => {});
    const storage = {
      forProvider: jest.fn(() => ({
        listObjects: jest.fn(async () => ({
          keys: opts.listKeys ?? ['flui/x/a', 'flui/x/b'],
          hasMore: false,
        })),
        deleteObjects,
      })),
    };
    const sweeper = new BackupRetentionSweeper(
      artifactRepo as any,
      locationRepo as any,
      jobRepo as any,
      restoreRepo as any,
      destRepo as any,
      destinations as any,
      storage as any,
      {
        forEngine: (e: string) => {
          const known = opts.selfPruningEngines ?? ['postgres'];
          if (e === 'something-from-the-future') {
            throw new Error('No continuous-backup engine is registered');
          }
          return {
            selfPrunesRepository: known.includes(e ?? 'postgres'),
            artifactObjectKeys: opts.engineKeys,
          };
        },
      } as any,
      {
        findDbPolicyForApp: jest.fn(async () =>
          opts.dbPolicy === null
            ? null
            : (opts.dbPolicy ?? { id: 'p1', retentionMaxCopies: 2 }),
        ),
      } as any,
    );
    return {
      sweeper,
      artifactRepo,
      locationRepo,
      deletedArtifacts,
      deleteObjects,
    };
  }

  const artifact = (over: Partial<any> = {}) => ({
    id: 'a1',
    backupJobId: 'j1',
    clusterId: 'c1',
    engineClass: BackupEngineClass.VOLUME_COPY,
    applicationId: 'app1',
    volumeName: 'data-pg-0',
    metadata: {},
    ...over,
  });

  it('deletes the objects before the row', async () => {
    const order: string[] = [];
    const deleteObjects = jest.fn(async () => {
      order.push('objects');
    });
    const { sweeper, artifactRepo } = make({
      expired: [artifact()],
      deleteObjects,
    });
    artifactRepo.delete.mockImplementation(async () => {
      order.push('row');
      return {};
    });

    await sweeper.sweep();

    // The other order leaks storage nothing points at any more.
    expect(order).toEqual(['objects', 'row']);
  });

  it('never deletes the last copy of what it protects', async () => {
    const { sweeper, deletedArtifacts } = make({
      expired: [artifact()],
      siblings: 1,
    });

    await sweeper.sweep();

    // A window that has quietly emptied looks exactly like one that was never
    // set up, right up until somebody needs it.
    expect(deletedArtifacts).toEqual([]);
  });

  it('never deletes an artifact a running restore is reading', async () => {
    const { sweeper, deletedArtifacts } = make({
      expired: [artifact()],
      inFlightRestores: 1,
    });

    await sweeper.sweep();

    expect(deletedArtifacts).toEqual([]);
  });

  it('never touches a copy nobody scheduled', async () => {
    const { sweeper, deletedArtifacts } = make({
      expired: [artifact()],
      jobs: [{ id: 'j1', policyId: null }],
    });

    await sweeper.sweep();

    // An ad-hoc copy was made by a person; nothing scheduled it, so nothing
    // may unschedule it either.
    expect(deletedArtifacts).toEqual([]);
  });

  it('drops the row but never the objects of a self-pruning engine', async () => {
    const { sweeper, deletedArtifacts, deleteObjects } = make({
      expired: [artifact({ engineClass: BackupEngineClass.DATABASE })],
    });

    await sweeper.sweep();

    // pgBackRest owns that repository and expires it by its own retention;
    // deleting objects underneath it breaks a chain Flui does not own.
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(deletedArtifacts).toEqual(['a1']);
  });

  it('keeps the row of an engine that prunes neither itself nor through here', async () => {
    // The ninth deletion that must not happen, and the quietest. MariaDB has
    // no equivalent of `repo1-retention-full`: dropping its row on expiry
    // would leave the base backup and its binary logs in object storage,
    // still paid for and pointed at by nothing, while the ledger — built so
    // that "what protects this application" is one query — answered nothing.
    const { sweeper, deletedArtifacts, deleteObjects, artifactRepo } = make({
      expired: [
        artifact({
          engineClass: BackupEngineClass.DATABASE,
          engine: 'mariadb',
        }),
      ],
      selfPruningEngines: ['postgres'],
    });

    await sweeper.sweep();

    expect(deleteObjects).not.toHaveBeenCalled();
    expect(deletedArtifacts).toEqual([]);
    expect(artifactRepo.update).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({
        metadata: expect.objectContaining({ retentionUnenforced: true }),
      }),
    );
  });

  it('keeps the row of an engine this build has never heard of', async () => {
    // A backup taken by a version of Flui that supported an engine this one
    // does not. Keeping both the row and the objects is the only answer that
    // cannot destroy something it cannot understand.
    const { sweeper, deletedArtifacts, deleteObjects } = make({
      expired: [
        artifact({
          engineClass: BackupEngineClass.DATABASE,
          engine: 'something-from-the-future',
        }),
      ],
      selfPruningEngines: [],
    });

    await sweeper.sweep();

    expect(deleteObjects).not.toHaveBeenCalled();
    expect(deletedArtifacts).toEqual([]);
  });

  it('never deletes the newest base of a chain', async () => {
    // For a pile of independent copies "the last one" is the right unit. For a
    // chain it is not: deleting the newest keeps the row count healthy and
    // moves the END of the recoverable window backwards, so the window ends
    // earlier than the row claims. Shortening retention must shorten the
    // start, never the end.
    const { sweeper, deletedArtifacts } = make({
      expired: [
        artifact({
          engineClass: BackupEngineClass.DATABASE,
          engine: 'mariadb',
          applicationId: 'app-1',
          engineRef: 'base-newest',
        }),
      ],
      newestDbArtifact: { id: 'a1' },
      selfPruningEngines: [],
    });

    await sweeper.sweep();

    expect(deletedArtifacts).toEqual([]);
  });

  it('deletes a base backup through its engine, position file first', async () => {
    // The reverse of the upload order, and the reason it is a contract: a base
    // becomes visible to a reader when its position file lands, so removing
    // that first takes the whole base out of view in one operation. The other
    // order leaves, on any interruption, a base every reader still believes in
    // and none can fetch.
    const deleted: string[][] = [];
    const { sweeper, deletedArtifacts } = make({
      expired: [
        artifact({
          engineClass: BackupEngineClass.DATABASE,
          engine: 'mariadb',
          applicationId: 'app-1',
          engineRef: 'base-old',
        }),
      ],
      selfPruningEngines: [],
      engineKeys: (appId: string, ref: string) => [
        `mariadb/${appId}/base/${ref}/binlog_info`,
        `mariadb/${appId}/base/${ref}/base.mbstream`,
      ],
      deleteObjects: jest.fn(async (_c: any, keys: string[]) => {
        deleted.push(keys);
      }),
    });

    await sweeper.sweep();

    expect(deleted).toEqual([
      ['mariadb/app-1/base/base-old/binlog_info'],
      ['mariadb/app-1/base/base-old/base.mbstream'],
    ]);
    expect(deletedArtifacts).toEqual(['a1']);
  });

  it('records a failed prune on the row instead of retrying in silence', async () => {
    const { sweeper, artifactRepo } = make({
      expired: [artifact()],
      deleteObjects: jest.fn(async () => {
        throw new Error('bucket gone');
      }),
    });

    await sweeper.sweep();

    expect(artifactRepo.update).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({
        metadata: expect.objectContaining({
          pruneAttempts: 1,
          pruneLastError: 'bucket gone',
        }),
      }),
    );
  });

  it('caps how much one pass may delete', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      artifact({ id: `a${i}`, backupJobId: `j${i}` }),
    );
    const { sweeper, deletedArtifacts } = make({
      expired: many,
      jobs: many.map((a) => ({ id: a.backupJobId, policyId: 'p1' })),
    });

    await sweeper.sweep();

    expect(deletedArtifacts).toHaveLength(25);
  });

  it('does nothing when nothing has expired', async () => {
    const { sweeper, deletedArtifacts, deleteObjects } = make({ expired: [] });

    await sweeper.sweep();

    expect(deletedArtifacts).toEqual([]);
    expect(deleteObjects).not.toHaveBeenCalled();
  });
});
