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
    } = {},
  ) {
    const deletedArtifacts: string[] = [];
    const artifactRepo = {
      find: jest.fn(async () => opts.expired ?? []),
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
