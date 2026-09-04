import { VolumeCopyLedgerService } from './volume-copy-ledger.service';
import { BackupEngineClass } from '../../backups/enums/backup-engine-class.enum';

describe('VolumeCopyLedgerService', () => {
  function make(overrides: { artifacts?: any[] } = {}) {
    const saved = {
      jobs: [] as any[],
      artifacts: [] as any[],
      locations: [] as any[],
    };
    const repo = (bucket: any[]) => ({
      create: jest.fn((d: any) => d),
      save: jest.fn(async (d: any) => {
        const row = { id: `id-${bucket.length + 1}`, ...d };
        bucket.push(row);
        return row;
      }),
      find: jest.fn(async () => overrides.artifacts ?? []),
    });
    const jobRepo = repo(saved.jobs);
    const artifactRepo = repo(saved.artifacts);
    const locationRepo = repo(saved.locations);
    const service = new VolumeCopyLedgerService(
      jobRepo as any,
      artifactRepo as any,
      locationRepo as any,
    );
    return { service, saved, jobRepo, artifactRepo, locationRepo };
  }

  const base = {
    clusterId: 'cluster-1',
    applicationId: 'app-1',
    applicationSlug: 'my-db',
    volumeName: 'data-my-db-0',
    exportId: 'my-db-snap-20260904',
  };

  it('records a clone as a volume-copy artifact with no location', async () => {
    const { service, saved } = make();

    await service.record({ ...base, sink: 'pvc-clone', sizeBytes: 1024 });

    expect(saved.jobs).toHaveLength(1);
    // Nothing schedules an ad-hoc copy: a job with no policy is the point.
    expect(saved.jobs[0].policyId).toBeUndefined();
    expect(saved.artifacts[0]).toMatchObject({
      engineClass: BackupEngineClass.VOLUME_COPY,
      applicationId: 'app-1',
      volumeName: 'data-my-db-0',
    });
    expect(saved.locations).toHaveLength(0);
    expect(saved.artifacts[0].manifestSummary.survivesAppDeletion).toBe(false);
  });

  it('defaults quiesce to none rather than leaving it unsaid', async () => {
    const { service, saved } = make();

    await service.record({ ...base, sink: 'pvc-clone', writersAtStart: 1 });

    // A row with no quiesce field reads as "unknown"; the truth about a copy
    // taken with no flag is "nothing was stopped", and that is a fact.
    expect(saved.artifacts[0].manifestSummary).toMatchObject({
      quiesce: 'none',
      writersAtStart: 1,
    });
  });

  it('keeps a probe that found nothing distinct from one that never ran', async () => {
    const { service, saved } = make();

    await service.record({ ...base, sink: 'pvc-clone' });
    await service.record({
      ...base,
      exportId: 'probed',
      sink: 'pvc-clone',
      dataDirectoryDetected: null,
    });

    // `null` says "we looked and found no data directory"; absent says "we did
    // not look". Collapsing them would let an unprobed copy read as clean.
    expect(saved.artifacts[0].manifestSummary).not.toHaveProperty(
      'dataDirectoryDetected',
    );
    expect(saved.artifacts[1].manifestSummary.dataDirectoryDetected).toBeNull();
  });

  it('records that the user copied a detected data directory anyway', async () => {
    const { service, saved } = make();

    await service.record({
      ...base,
      sink: 'pvc-clone',
      dataDirectoryDetected: 'postgres',
      acknowledgedInconsistent: true,
    });

    expect(saved.artifacts[0].manifestSummary).toMatchObject({
      dataDirectoryDetected: 'postgres',
      acknowledgedInconsistent: true,
      quiesce: 'none',
    });
  });

  it('links an S3 archive to the destination it was written to', async () => {
    const { service, saved } = make();

    await service.record({
      ...base,
      sink: 's3-archive',
      sizeBytes: 2048,
      destinationId: 'dest-1',
      objectKeyPrefix: 'flui/cluster-1/my-db/2026',
    });

    expect(saved.locations).toHaveLength(1);
    expect(saved.locations[0]).toMatchObject({
      destinationId: 'dest-1',
      objectKeyPrefix: 'flui/cluster-1/my-db/2026',
    });
    expect(saved.artifacts[0].manifestSummary.survivesAppDeletion).toBe(true);
  });

  it('forgets a copy that has been deleted, with its job and locations', async () => {
    const { service } = make();
    const artifactRepo = {
      find: jest.fn(async () => [{ id: 'a1', backupJobId: 'j1' }]),
      delete: jest.fn(async () => ({})),
    };
    const locationRepo = { delete: jest.fn(async () => ({})) };
    const jobRepo = { delete: jest.fn(async () => ({})) };
    const svc = new (service.constructor as any)(
      jobRepo,
      artifactRepo,
      locationRepo,
    );

    await svc.forget('app-1', 'my-db-snap-20260904');

    // A row left behind claims protection that no longer exists, which reads
    // worse than never having listed it.
    expect(locationRepo.delete).toHaveBeenCalledWith({ artifactId: 'a1' });
    expect(artifactRepo.delete).toHaveBeenCalledWith({ id: 'a1' });
    expect(jobRepo.delete).toHaveBeenCalledWith({ id: 'j1' });
  });

  it('never fails a delete because the bookkeeping failed', async () => {
    const { service } = make();
    const svc = new (service.constructor as any)(
      {},
      {
        find: jest.fn(async () => {
          throw new Error('db down');
        }),
      },
      {},
    );

    await expect(svc.forget('app-1', 'gone')).resolves.toBeUndefined();
  });

  it('never fails the caller when the row cannot be written', async () => {
    const { service, jobRepo } = make();
    jobRepo.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.record({ ...base, sink: 'pvc-clone' }),
    ).resolves.toBeNull();
  });

  it('reconcile registers only copies the ledger does not already know', async () => {
    const { service, saved } = make({
      artifacts: [{ engineRef: 'already-there' }],
    });

    await service.reconcile('cluster-1', 'app-1', 'my-db', [
      { exportId: 'already-there', sourcePvcName: 'data-my-db-0' },
      { exportId: 'brand-new', sourcePvcName: 'data-my-db-0', actualBytes: 10 },
    ]);

    expect(saved.artifacts.map((a) => a.engineRef)).toEqual(['brand-new']);
  });

  it('reconcile drops a clone row whose copy is no longer on the cluster', async () => {
    const rows = [
      { id: 'a1', engineRef: 'gone', manifestSummary: { sink: 'pvc-clone' } },
      {
        id: 'a2',
        engineRef: 'still-here',
        manifestSummary: { sink: 'pvc-clone' },
      },
      {
        id: 'a3',
        engineRef: 'archived',
        manifestSummary: { sink: 's3-archive' },
      },
    ];
    const deleted: string[] = [];
    const artifactRepo = {
      // Two different queries reach this repo: reconcile asks for every
      // volume-copy row, forget asks for the one row with a given engineRef.
      find: jest.fn(async (q: any) =>
        q?.where?.engineClass
          ? rows
          : rows.filter((r) => r.engineRef === q?.where?.engineRef),
      ),
      delete: jest.fn(async (q: any) => {
        deleted.push(q.id);
        return {};
      }),
      create: jest.fn((d: any) => d),
      save: jest.fn(async (d: any) => ({ id: 'new', ...d })),
    };
    const svc = new (make().service.constructor as any)(
      { delete: jest.fn(async () => ({})) },
      artifactRepo,
      { delete: jest.fn(async () => ({})) },
    );

    await svc.reconcile('cluster-1', 'app-1', 'my-db', [
      { exportId: 'still-here', sourcePvcName: 'data-my-db-0' },
    ]);

    // The S3 archive is not listed from the cluster at all, so its absence
    // from that list says nothing about whether it still exists.
    expect(deleted).toEqual(['a1']);
  });

  it('reconcile does nothing when there is nothing on the cluster', async () => {
    const { service, saved, artifactRepo } = make();

    await service.reconcile('cluster-1', 'app-1', 'my-db', []);

    expect(artifactRepo.find).not.toHaveBeenCalled();
    expect(saved.artifacts).toHaveLength(0);
  });
});
