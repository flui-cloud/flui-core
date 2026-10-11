jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { In, Not } from 'typeorm';
import { ScheduledJobsImportService } from './scheduled-jobs-import.service';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';

describe('recording schedules found on the clusters', () => {
  it('asks only clusters that still exist', async () => {
    const find = jest.fn(async () => []);
    const service = new ScheduledJobsImportService(
      { find } as never,
      {} as never,
      { listResourcesByLabelEverywhere: jest.fn() } as never,
      { decrypt: (v: string) => v } as never,
      {} as never,
    );
    await service.importAll();
    expect(find).toHaveBeenCalledWith({
      where: {
        status: Not(In([ClusterStatus.DELETED, ClusterStatus.DELETING])),
      },
    });
  });
});
