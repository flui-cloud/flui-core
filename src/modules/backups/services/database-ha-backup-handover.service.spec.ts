jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { DatabaseHaBackupHandoverService } from './database-ha-backup-handover.service';

describe('continuous backup following a database to high availability', () => {
  function build(policy: Record<string, unknown> | null) {
    const policyRepo = {
      findDbPolicyForApp: jest.fn().mockResolvedValue(policy),
      update: jest.fn(),
    };
    const jobs = { createOnDemand: jest.fn() };
    const ha = {
      engine: 'postgres-ha',
      mintGeneration: () => '20261108120000',
      enable: jest.fn(),
      requireTooling: jest.fn().mockResolvedValue(undefined),
    };
    const service = new DatabaseHaBackupHandoverService(
      policyRepo as never,
      { findById: jest.fn().mockResolvedValue({ id: 'd1' }) } as never,
      { primaryDestinationOf: () => ({ destinationId: 'd1' }) } as never,
      jobs as never,
      ha as never,
    );
    return { service, policyRepo, jobs, ha };
  }

  it('moves the policy to a repository of its own and takes a full right away', async () => {
    const { service, policyRepo, jobs, ha } = build({
      id: 'p1',
      engine: 'postgres',
      userId: 'u1',
      retentionMaxCopies: 3,
      metadata: { generation: 'old' },
    });

    await expect(service.handOver('a1')).resolves.toContain(
      'first full backup',
    );

    expect(ha.enable).toHaveBeenCalledWith(
      'a1',
      { id: 'd1' },
      {
        retentionFull: 3,
        generation: '20261108120000',
      },
    );
    expect(policyRepo.update).toHaveBeenCalledWith('p1', {
      engine: 'postgres-ha',
      metadata: { generation: '20261108120000' },
    });
    expect(jobs.createOnDemand).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ policyId: 'p1' }),
      'scheduled',
    );
  });

  it('leaves alone a database with no policy, one already moved, and one backed up by dumps', async () => {
    for (const policy of [
      null,
      { engine: 'postgres-ha' },
      { engine: 'postgres-dump' },
    ]) {
      const { service, ha } = build(policy);
      await expect(service.handOver('a1')).resolves.toBeNull();
      expect(ha.enable).not.toHaveBeenCalled();
    }
  });
});
