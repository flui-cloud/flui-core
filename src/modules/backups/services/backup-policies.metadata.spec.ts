jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BackupPoliciesService } from './backup-policies.service';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { DestinationRole } from '../enums/destination-role.enum';

/**
 * Every policy was saved with `{}` as its metadata, so
 * `backup enable volumes --exclude` excluded nothing and a MariaDB policy
 * never kept the generation its history is written under.
 */
describe('what a backup policy remembers', () => {
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
    };
    const placement = { assertOffProvider: jest.fn(async () => undefined) };
    const service = new BackupPoliciesService(
      repo as any,
      placement as any,
      {} as any,
      {} as any,
    );
    return { service, created };
  };

  const dto = (metadata: any) => ({
    name: 'n',
    clusterId: 'c',
    engineClass: BackupEngineClass.VOLUME_COPY,
    scope: BackupScope.APPLICATIONS,
    scopeSelector: { applicationIds: ['a'] },
    destinations: [{ destinationId: 'd', role: DestinationRole.PRIMARY }],
    metadata,
  });

  it('keeps the options a person set', async () => {
    const { service, created } = make();
    await service.create(
      'u',
      dto({ excludeVolumes: ['cache'], pauseDuringCopy: true }) as any,
    );
    expect(created[0].metadata).toEqual({
      excludeVolumes: ['cache'],
      pauseDuringCopy: true,
    });
  });

  it("keeps Flui's own facts, and never takes them from the request", async () => {
    const { service, created } = make();
    await service.create('u', dto({ generation: 'forged' }) as any, {
      generation: 'g1',
    });
    expect(created[0].metadata).toEqual({ generation: 'g1' });
  });
});
