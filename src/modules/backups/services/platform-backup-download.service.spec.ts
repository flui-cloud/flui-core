import { NotFoundException } from '@nestjs/common';
import { PlatformBackupDownloadService } from './platform-backup-download.service';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';

const location = (key: string, state = ArtifactLocationState.AVAILABLE) => ({
  destinationId: 'dest-1',
  objectKeyPrefix: key,
  state,
});
const artifact = (
  ref: string,
  key: string,
  size: string,
  state?: ArtifactLocationState,
) => ({
  id: `a-${ref}`,
  backupJobId: 'job-1',
  engineRef: ref,
  sizeBytes: size,
  createdAt: new Date('2026-09-30T12:16:14Z'),
  locations: [location(key, state)],
});
const RUN = 'platform/c1/2026-09-30T12-16-12Z';

function setup(found: unknown[], latest: string | null = 'job-1') {
  const artifacts = {
    listByJob: jest.fn(async () => found),
    latestPlatformJobId: jest.fn(async () => latest),
  };
  const destinations = {
    findById: jest.fn(async () => ({ id: 'dest-1', provider: 'scaleway' })),
    toCredentials: jest.fn(() => ({ bucket: 'b' })),
  };
  const presignDownload = jest.fn(
    async (_c: unknown, key: string, ttl: number) =>
      `https://s3/${key}?ttl=${ttl}`,
  );
  const storage = { forProvider: jest.fn(() => ({ presignDownload })) };
  const service = new PlatformBackupDownloadService(
    artifacts as never,
    destinations as never,
    storage as never,
  );
  service.now = () => Date.parse('2026-09-30T12:30:00Z');
  return { service, artifacts, presignDownload };
}

describe('PlatformBackupDownloadService', () => {
  const complete = [
    artifact('platform:db', `${RUN}/db/flui-pg.dump.gz.enc`, '120000'),
    artifact('platform:keys', `${RUN}/keys/keybundle.age`, '900'),
  ];

  it('links the key bundle and the dump of the newest platform backup', async () => {
    const { service, artifacts, presignDownload } = setup(complete);
    const out = await service.links();

    expect(artifacts.listByJob).toHaveBeenCalledWith('job-1');
    expect(out.jobId).toBe('job-1');
    expect(out.expiresAt.toISOString()).toBe('2026-09-30T12:40:00.000Z');
    expect(out.files).toEqual([
      {
        kind: 'keys',
        name: 'keybundle.age',
        sizeBytes: 900,
        url: `https://s3/${RUN}/keys/keybundle.age?ttl=600`,
      },
      {
        kind: 'db',
        name: 'flui-pg.dump.gz.enc',
        sizeBytes: 120000,
        url: `https://s3/${RUN}/db/flui-pg.dump.gz.enc?ttl=600`,
      },
    ]);
    expect(presignDownload).toHaveBeenCalledTimes(2);
  });

  it('uses the job it is given', async () => {
    const { service, artifacts } = setup(complete);
    await service.links('job-7');
    expect(artifacts.listByJob).toHaveBeenCalledWith('job-7');
    expect(artifacts.latestPlatformJobId).not.toHaveBeenCalled();
  });

  it('says so when no platform backup exists', async () => {
    const { service } = setup([], null);
    await expect(service.links()).rejects.toThrow(
      'No platform backup has been taken yet.',
    );
  });

  it('refuses a job that is not a complete platform backup', async () => {
    const { service } = setup([complete[0]]);
    await expect(service.links('job-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a part that is not available at any destination', async () => {
    const { service } = setup([
      complete[0],
      artifact(
        'platform:keys',
        `${RUN}/keys/keybundle.age`,
        '900',
        ArtifactLocationState.EXPIRED,
      ),
    ]);
    await expect(service.links('job-1')).rejects.toThrow(
      'The platform:keys part of backup job job-1 is not available at any destination.',
    );
  });
});
