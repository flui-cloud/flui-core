jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { DbPitrService } from './db-pitr.service';

function build(base: Record<string, unknown> | null) {
  const point = {
    id: 'rp-1',
    backupJobId: 'job-rp',
    clusterId: 'c1',
    engineClass: 'database',
    manifestSummary: {
      kind: 'restore-point',
      restorePointFor: 'pg-app',
      recoverTo: '2026-10-01T10:00:00.000Z',
    },
    locations: [],
  };
  const artifacts = {
    findArtifact: jest.fn(async (id: string) => (id === 'rp-1' ? point : base)),
    findDbArtifactForAppAt: jest.fn(async () => base),
  };
  const restoreJobs = { create: jest.fn().mockResolvedValue({ id: 'rj-1' }) };
  const service = new DbPitrService(
    { findOne: jest.fn() } as never,
    artifacts as never,
    null as never,
    restoreJobs as never,
    null as never,
    { findOne: jest.fn().mockResolvedValue({ userId: 'u1' }) } as never,
    { exists: jest.fn().mockResolvedValue(true) } as never,
  );
  return { service, artifacts, restoreJobs };
}

describe('restoring a restore point taken before a deploy', () => {
  it('replays the newest base that finished before it, up to the point', async () => {
    const { service, artifacts, restoreJobs } = build({
      id: 'base-1',
      backupJobId: 'job-base',
      clusterId: 'c1',
      engineClass: 'database',
      locations: [{ role: 'primary', destinationId: 'dest-1' }],
    });
    await service.restoreArtifact('u1', 'rp-1', { name: 'pg-before' });
    expect(artifacts.findDbArtifactForAppAt).toHaveBeenCalledWith(
      'pg-app',
      new Date('2026-10-01T10:00:00.000Z'),
    );
    expect(restoreJobs.create).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        artifactId: 'base-1',
        sourceDestinationId: 'dest-1',
        recoveryTargetTime: '2026-10-01T10:00:00.000Z',
      }),
    );
  });

  it('says so when no base finished before the point', async () => {
    const { service } = build(null);
    await expect(
      service.restoreArtifact('u1', 'rp-1', { name: 'pg-before' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
