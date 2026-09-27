jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DbPitrService } from './db-pitr.service';

function build(opts: { owner?: string; clusterExists?: boolean } = {}) {
  const artifact = {
    id: 'art-1',
    backupJobId: 'job-1',
    clusterId: 'c-old',
    engineClass: 'database',
    locations: [{ role: 'primary', destinationId: 'dest-1' }],
  };
  const restoreJobs = { create: jest.fn().mockResolvedValue({ id: 'rj-1' }) };
  const appRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const service = new DbPitrService(
    appRepo as never,
    { findArtifact: jest.fn().mockResolvedValue(artifact) } as never,
    null as never,
    restoreJobs as never,
    null as never,
    {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'job-1', userId: opts.owner ?? 'u1' }),
    } as never,
    {
      exists: jest.fn().mockResolvedValue(opts.clusterExists ?? true),
    } as never,
  );
  return { service, restoreJobs, appRepo };
}

describe('DbPitrService.restoreArtifact — a database that no longer exists', () => {
  it('restores from the backup without looking for the deleted application', async () => {
    const { service, restoreJobs, appRepo } = build();
    await service.restoreArtifact('u1', 'art-1', { name: 'pg-back' });
    expect(appRepo.findOne).not.toHaveBeenCalled();
    expect(restoreJobs.create).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        artifactId: 'art-1',
        targetKind: 'database',
        targetClusterId: 'c-old',
        targetSelector: { newInstall: { name: 'pg-back', clusterId: 'c-old' } },
      }),
    );
  });

  it("refuses someone else's backup as if it did not exist", async () => {
    const { service } = build({ owner: 'u2' });
    await expect(
      service.restoreArtifact('u1', 'art-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('asks for a cluster when the source cluster is gone', async () => {
    const { service } = build({ clusterExists: false });
    await expect(
      service.restoreArtifact('u1', 'art-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
