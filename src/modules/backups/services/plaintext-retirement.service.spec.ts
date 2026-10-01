import {
  PLAINTEXT_RETIRED_REASON,
  PlaintextRetirementService,
} from './plaintext-retirement.service';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';

const crypt = { repository: { cipher: 'rclone-crypt-v1' } };

function make(opts: { artifacts: any[]; objects: Record<string, string[]> }) {
  const deleted: Array<{ pathPrefix?: string; keys: string[] }> = [];
  const listed: Array<{ pathPrefix?: string; prefix: string }> = [];
  const locationUpdates: any[] = [];
  const artifactUpdates: any[] = [];
  const backend = {
    listObjects: jest.fn(async (creds: any, prefix: string) => {
      listed.push({ pathPrefix: creds.pathPrefix, prefix });
      return { keys: opts.objects[prefix] ?? [], hasMore: false };
    }),
    deleteObjects: jest.fn(async (creds: any, keys: string[]) => {
      deleted.push({ pathPrefix: creds.pathPrefix, keys });
    }),
  };
  const service = new PlaintextRetirementService(
    {
      find: jest.fn(async () => opts.artifacts),
      update: jest.fn(async (id: string, patch: any) => {
        artifactUpdates.push({ id, patch });
      }),
    } as never,
    {
      update: jest.fn(async (where: any, patch: any) => {
        locationUpdates.push({ where, patch });
      }),
    } as never,
    { findById: async (id: string) => ({ id, bucket: 'b' }) } as never,
    {
      toCredentials: (d: any) => ({
        provider: 'generic_s3',
        bucket: d.bucket,
        pathPrefix: 'pre',
      }),
    } as never,
    { forProvider: () => backend } as never,
  );
  return {
    service,
    backend,
    deleted,
    listed,
    locationUpdates,
    artifactUpdates,
  };
}

describe('retiring plaintext backups once an encrypted one exists', () => {
  const dbArtifacts = () => [
    {
      id: 'enc',
      manifestSummary: crypt,
      locations: [{ destinationId: 'd1', state: 'available' }],
    },
    {
      id: 'old',
      manifestSummary: {},
      metadata: { kept: true },
      locations: [{ destinationId: 'd1', state: 'available' }],
    },
  ];

  it('deletes every plaintext object under the engine prefix and nothing encrypted', async () => {
    const { service, deleted, artifactUpdates, locationUpdates } = make({
      artifacts: dbArtifacts().filter((a) => a.id !== 'enc'),
      objects: {
        'mariadb/app-1/': [
          'pre/mariadb/app-1/g1/base/base-a/binlog_info',
          'pre/mariadb/app-1/g1/base/base-a/base.mbstream',
          'pre/mariadb/app-1/g1/binlog/binlog.000001',
          'pre/mariadb/app-1/g1/base/base-b/binlog_info.bin',
          'pre/mariadb/app-1/g1/binlog/binlog.000002.bin',
        ],
      },
    });

    const report = await service.afterEncryptedDatabaseBackup({
      appId: 'app-1',
      engine: 'mariadb',
      enginePrefix: 'mariadb/app-1/',
      destinationId: 'd1',
      encryptedArtifactId: 'enc',
    });

    expect(deleted).toEqual([
      {
        pathPrefix: 'pre',
        keys: [
          'pre/mariadb/app-1/g1/base/base-a/binlog_info',
          'pre/mariadb/app-1/g1/base/base-a/base.mbstream',
          'pre/mariadb/app-1/g1/binlog/binlog.000001',
        ],
      },
    ]);
    expect(report).toEqual({ deletedKeys: 3, retiredArtifacts: ['old'] });
    expect(artifactUpdates).toEqual([
      {
        id: 'old',
        patch: {
          metadata: {
            kept: true,
            plaintextRetiredAt: expect.any(String),
          },
        },
      },
    ]);
    expect(locationUpdates[0].patch).toEqual({
      state: ArtifactLocationState.EXPIRED,
      lastError: PLAINTEXT_RETIRED_REASON,
    });
  });

  it('does nothing the second time', async () => {
    const { service, backend, artifactUpdates, locationUpdates } = make({
      artifacts: [
        {
          id: 'old',
          manifestSummary: {},
          metadata: { plaintextRetiredAt: 'then' },
          locations: [{ destinationId: 'd1', state: 'expired' }],
        },
      ],
      objects: {
        'dumps/app-1/': ['pre/dumps/app-1/L1/dump.pgdump.bin'],
      },
    });

    const report = await service.afterEncryptedDatabaseBackup({
      appId: 'app-1',
      engine: 'postgres-dump',
      enginePrefix: 'dumps/app-1/',
      destinationId: 'd1',
      encryptedArtifactId: 'enc',
    });

    expect(backend.deleteObjects).not.toHaveBeenCalled();
    expect(artifactUpdates).toEqual([]);
    expect(locationUpdates).toEqual([]);
    expect(report).toEqual({ deletedKeys: 0, retiredArtifacts: [] });
  });

  it('refuses a prefix that is not one application’s', async () => {
    const { service, backend } = make({ artifacts: [], objects: {} });
    await expect(
      service.afterEncryptedDatabaseBackup({
        appId: 'app-1',
        engine: 'mariadb',
        enginePrefix: 'mariadb/',
        destinationId: 'd1',
        encryptedArtifactId: 'enc',
      }),
    ).rejects.toThrow(/not an application prefix/);
    expect(backend.listObjects).not.toHaveBeenCalled();
  });

  it('removes each plaintext volume copy by its own prefix, never by name', async () => {
    const { service, deleted, listed } = make({
      artifacts: [
        {
          id: 'enc',
          manifestSummary: { sink: 's3-archive', ...crypt },
          locations: [
            {
              destinationId: 'd1',
              state: 'available',
              objectKeyPrefix: 'pre/exports/app/new',
            },
          ],
        },
        {
          id: 'old',
          manifestSummary: { sink: 's3-archive' },
          locations: [
            {
              destinationId: 'd1',
              state: 'available',
              objectKeyPrefix: 'pre/exports/app/old',
            },
          ],
        },
        {
          id: 'clone',
          manifestSummary: { sink: 'pvc-clone' },
          locations: [],
        },
      ].filter((a) => a.id !== 'enc'),
      objects: {
        'pre/exports/app/old/': [
          'pre/exports/app/old/firmware.bin',
          'pre/exports/app/old/notes.txt',
        ],
      },
    });

    const report = await service.afterEncryptedVolumeCopy({
      appId: 'app-1',
      volumeName: 'data',
      encryptedArtifactId: 'enc',
    });

    expect(listed).toEqual([
      { pathPrefix: undefined, prefix: 'pre/exports/app/old/' },
    ]);
    expect(deleted[0].keys).toEqual([
      'pre/exports/app/old/firmware.bin',
      'pre/exports/app/old/notes.txt',
    ]);
    expect(report.retiredArtifacts).toEqual(['old']);
  });
});
