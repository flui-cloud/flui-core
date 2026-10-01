import { KopiaReplicationService } from './kopia-replication.service';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';

describe('after a volume copy, the repository is mirrored to each replica', () => {
  function build(produced: Array<{ id: string }>) {
    const artifacts = {
      listByJob: jest.fn(async () => produced),
      saveLocations: jest.fn(async (locs: any[]) =>
        locs.map((l, i) => ({ ...l, id: `loc-${i}` })),
      ),
    };
    const queue = { add: jest.fn(async () => undefined) };
    return {
      service: new KopiaReplicationService(artifacts as any, queue as any),
      artifacts,
      queue,
    };
  }

  const policy = {
    id: 'p1',
    destinations: [
      { destinationId: 'd1', role: 'primary' },
      { destinationId: 'd2', role: 'replica', priority: 1 },
      { destinationId: 'd3', role: 'replica', enabled: false },
    ],
  };

  it("syncs the application's repository, not a single backup, and records a replica row per artifact", async () => {
    const { service, artifacts, queue } = build([{ id: 'a' }, { id: 'b' }]);
    const n = await service.afterRun({
      policy,
      applicationId: 'app-1',
      backupJobId: 'job-1',
      primaryDestinationId: 'd1',
    });
    expect(n).toBe(1);
    expect(artifacts.saveLocations).toHaveBeenCalledWith([
      expect.objectContaining({
        artifactId: 'a',
        destinationId: 'd2',
        role: 'replica',
        state: ArtifactLocationState.PENDING,
        objectKeyPrefix: 'kopia/app-1/',
      }),
      expect.objectContaining({ artifactId: 'b', destinationId: 'd2' }),
    ]);
    expect(queue.add).toHaveBeenCalledWith(
      'replicate-backup',
      {
        mode: 'kopia-repository',
        applicationId: 'app-1',
        backupJobId: 'job-1',
        sourceDestinationId: 'd1',
        targetDestinationId: 'd2',
        locationIds: ['loc-0', 'loc-1'],
      },
      expect.any(Object),
    );
  });

  it('does nothing without a replica, or when the run stored nothing', async () => {
    const none = build([{ id: 'a' }]);
    expect(
      await none.service.afterRun({
        policy: {
          id: 'p',
          destinations: [{ destinationId: 'd1', role: 'primary' }],
        },
        applicationId: 'app-1',
        backupJobId: 'job-1',
        primaryDestinationId: 'd1',
      }),
    ).toBe(0);
    const empty = build([]);
    expect(
      await empty.service.afterRun({
        policy,
        applicationId: 'app-1',
        backupJobId: 'job-1',
        primaryDestinationId: 'd1',
      }),
    ).toBe(0);
    expect(empty.queue.add).not.toHaveBeenCalled();
  });
});
