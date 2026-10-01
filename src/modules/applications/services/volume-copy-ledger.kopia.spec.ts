import { VolumeCopyLedgerService } from './volume-copy-ledger.service';

const SRC = 'flui@flui-app-1:/flui/volumes/data';
const record = {
  snapshotId: 'aaaa0000bbbb1111cccc2222dddd3333',
  rootObject: 'kf0c',
  source: 'flui@flui-app-1:/flui/volumes/data',
  repositoryPrefix: 'kopia/app-1/',
  logicalBytes: 5000,
  uploadedBytes: 300,
  repositoryBytes: 9000,
  compression: 'zstd-fastest',
  encryption: 'AES256-GCM-HMAC-SHA256',
  splitter: 'DYNAMIC-1M-BUZHASH',
  pinned: false,
  verifiedAt: '2026-10-01T02:00:00.000Z',
  kopiaVersion: '0.23.1',
};

function make(existing: any[] = []) {
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
    find: jest.fn(async () => existing),
    update: jest.fn(async () => undefined),
  });
  const jobRepo = repo(saved.jobs);
  const artifactRepo = repo(saved.artifacts);
  const locationRepo = repo(saved.locations);
  const service = new VolumeCopyLedgerService(
    jobRepo as any,
    artifactRepo as any,
    locationRepo as any,
  );
  return { service, saved, locationRepo };
}

describe('the ledger of kopia snapshots', () => {
  const copy = {
    clusterId: 'cl-1',
    applicationId: 'app-1',
    applicationSlug: 'web',
    volumeName: 'data',
    exportId: record.snapshotId,
    sink: 'kopia' as const,
    sizeBytes: 5000,
    objectKeyPrefix: 'kopia/app-1/',
    destinationId: 'dest-1',
    policyId: 'pol-1',
    backupJobId: 'job-run',
    expiresAt: new Date('2020-01-01'),
    encryption: {
      cipher: 'kopia-aes256-gcm-hmac-sha256',
      mode: 'flui_managed' as any,
    },
    sourceSizeGb: 10,
    kopia: record,
  };

  it('hangs the snapshot off the policy run, with its engine, sizes and repository', async () => {
    const { service, saved } = make();
    await service.record(copy);

    expect(saved.jobs).toHaveLength(0);
    expect(saved.artifacts[0]).toMatchObject({
      backupJobId: 'job-run',
      engine: 'kopia',
      engineRef: record.snapshotId,
      sizeBytes: '5000',
      encryptionMode: 'flui_managed',
      manifestSummary: {
        sink: 'kopia',
        sourceSizeGb: 10,
        kopia: record,
        repository: {
          objectKeyPrefix: 'kopia/app-1/',
          cipher: 'kopia-aes256-gcm-hmac-sha256',
        },
        survivesAppDeletion: true,
      },
    });
    expect(saved.locations[0]).toMatchObject({
      destinationId: 'dest-1',
      state: 'verified',
      objectKeyPrefix: 'kopia/app-1/',
      bytesStored: '300',
      verifiedAt: new Date(record.verifiedAt),
    });
  });

  it('never gives a kopia row an expiry, so no reaper deletes the shared repository by prefix', async () => {
    const { service, saved } = make();
    await service.record(copy);
    expect(saved.artifacts[0].expiresAt).toBeUndefined();
  });

  it('marks the snapshots kopia expired, and only those', async () => {
    const rows = [
      {
        id: 'a-old',
        manifestSummary: { kopia: { snapshotId: 'old', source: SRC } },
        locations: [{ destinationId: 'dest-1', state: 'available' }],
      },
      {
        id: 'a-kept',
        manifestSummary: { kopia: { snapshotId: 'kept', source: SRC } },
        locations: [{ destinationId: 'dest-1', state: 'available' }],
      },
      {
        id: 'a-other-dest',
        manifestSummary: { kopia: { snapshotId: 'elsewhere', source: SRC } },
        locations: [{ destinationId: 'dest-2', state: 'available' }],
      },
    ];
    const { service, locationRepo } = make(rows);
    const gone = await service.followKopiaRetention({
      applicationId: 'app-1',
      volumeName: 'data',
      destinationId: 'dest-1',
      listed: [
        {
          id: 'kept',
          source: {
            userName: 'flui',
            host: 'flui-app-1',
            path: '/flui/volumes/data',
          },
        },
      ],
    });
    expect(gone).toEqual(['a-old']);
    expect(locationRepo.update).toHaveBeenCalledWith(
      { artifactId: expect.anything(), destinationId: 'dest-1' },
      { state: 'expired' },
    );
  });

  it('reads the last spot check off the rows', async () => {
    const { service } = make([
      {
        id: 'a',
        locations: [
          { destinationId: 'dest-1', verifiedAt: new Date('2026-09-01') },
          { destinationId: 'dest-2', verifiedAt: new Date('2026-09-30') },
        ],
      },
    ]);
    expect(await service.lastKopiaVerification('app-1', 'dest-1')).toEqual(
      new Date('2026-09-01'),
    );
  });
});
