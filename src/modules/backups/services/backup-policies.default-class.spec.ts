jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BackupPoliciesService } from './backup-policies.service';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { DestinationRole } from '../enums/destination-role.enum';

describe('the engine a policy gets when none is named', () => {
  const make = () => {
    const created: any[] = [];
    const repo = {
      create: jest.fn((p: any) => {
        created.push(p);
        return p;
      }),
      save: jest.fn(async (p: any) => ({ ...p, id: 'p1' })),
      saveDestinations: jest.fn(async () => []),
      findById: jest.fn(async () => ({ id: 'p1', destinations: [] })),
      update: jest.fn(async () => undefined),
    };
    const service = new BackupPoliciesService(
      repo as any,
      { assertOffProvider: jest.fn(async () => undefined) } as any,
      {} as any,
      { supports: () => false, forEngine: () => ({}) } as any,
    );
    return { service, created, repo };
  };
  const destinations = [{ destinationId: 'd', role: DestinationRole.PRIMARY }];

  it('copies the volumes of the one application it names, never the cluster-wide engine', async () => {
    const { service, created } = make();
    await service.create('u', {
      name: 'n',
      clusterId: 'c',
      scope: BackupScope.APPLICATIONS,
      scopeSelector: { applicationIds: ['a'] },
      destinations,
    });
    expect(created[0].engineClass).toBe(BackupEngineClass.VOLUME_COPY);
  });

  it('asks a wider scope to say what protects it', async () => {
    const { service, created } = make();
    await expect(
      service.create('u', {
        name: 'n',
        clusterId: 'c',
        scope: BackupScope.CLUSTER_ALL,
        destinations,
      }),
    ).rejects.toThrow('engineClass');
    expect(created).toHaveLength(0);
  });

  it('changes the decisions on a volume-copy policy and nothing else', async () => {
    const { service, repo } = make();
    repo.findById.mockResolvedValueOnce({
      id: 'p1',
      engineClass: BackupEngineClass.VOLUME_COPY,
      metadata: { excludeVolumes: ['cache'], generation: 'g' },
      destinations: [],
    } as any);
    await service.updateOptions('p1', {
      pauseDuringCopy: true,
      excludeVolumes: ['cache', 'db', 'db'],
    });
    expect(repo.update).toHaveBeenCalledWith('p1', {
      metadata: {
        excludeVolumes: ['cache', 'db'],
        generation: 'g',
        pauseDuringCopy: true,
      },
    });

    repo.findById.mockResolvedValueOnce({
      id: 'p2',
      engineClass: BackupEngineClass.DATABASE,
      metadata: {},
      destinations: [],
    } as any);
    await expect(
      service.updateOptions('p2', { pauseDuringCopy: true }),
    ).rejects.toThrow('volume-copy');
  });
});
