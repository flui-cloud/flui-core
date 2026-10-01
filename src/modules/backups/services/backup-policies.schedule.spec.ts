jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BackupPoliciesService } from './backup-policies.service';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { DEFAULT_BACKUP_SCHEDULE } from '../utils/default-schedule.util';

describe('the schedule a backup policy gets when none is named', () => {
  const engineBy: Record<string, { engine: string; pointInTime?: boolean }> = {
    postgres: { engine: 'postgres' },
    mariadb: { engine: 'mariadb' },
    'postgres-dump': { engine: 'postgres-dump', pointInTime: false },
  };

  const make = (chosen = 'postgres') => {
    const created: any[] = [];
    const repo = {
      create: jest.fn((p: any) => {
        created.push(p);
        return p;
      }),
      save: jest.fn(async (p: any) => ({ ...p, id: 'p1' })),
      saveDestinations: jest.fn(async () => []),
      findById: jest.fn(async () => ({ id: 'p1', destinations: [] })),
      findDbPolicyForApp: jest.fn(async () => null),
    };
    const engine = {
      ...engineBy[chosen],
      enable: jest.fn(async () => undefined),
      disable: jest.fn(async () => undefined),
    };
    const engines = {
      chooseFor: jest.fn(async () => engine),
      supports: (e?: string | null) => (e ?? 'postgres') in engineBy,
      forEngine: (e?: string | null) => engineBy[e ?? 'postgres'],
    };
    const service = new BackupPoliciesService(
      repo as any,
      { assertOffProvider: jest.fn(async () => undefined) } as any,
      {} as any,
      engines as any,
    );
    return { service, created };
  };

  const dto = (engineClass: BackupEngineClass, cronSchedule?: string) => ({
    name: 'n',
    clusterId: 'c',
    engineClass,
    scope:
      engineClass === BackupEngineClass.PLATFORM
        ? BackupScope.CLUSTER_ALL
        : BackupScope.APPLICATIONS,
    scopeSelector: { applicationIds: ['a'] },
    destinations: [{ destinationId: 'd', role: DestinationRole.PRIMARY }],
    ...(cronSchedule ? { cronSchedule } : {}),
  });

  it.each([
    ['postgres', DEFAULT_BACKUP_SCHEDULE.continuousDatabase],
    ['mariadb', DEFAULT_BACKUP_SCHEDULE.continuousDatabase],
    ['postgres-dump', DEFAULT_BACKUP_SCHEDULE.databaseDump],
  ])('a %s database runs at %s', async (engine, cron) => {
    const { service, created } = make(engine);
    await service.enableDatabase(
      'u',
      dto(BackupEngineClass.DATABASE) as any,
      {} as any,
    );
    expect(created[0].cronSchedule).toBe(cron);
  });

  it('a continuous database takes a full base backup every seven days', async () => {
    const { service, created } = make('postgres');
    await service.enableDatabase(
      'u',
      dto(BackupEngineClass.DATABASE) as any,
      {} as any,
    );
    expect(created[0].metadata.fullEveryDays).toBe(7);
  });

  it('a dump has no full base backup to space out', async () => {
    const { service, created } = make('postgres-dump');
    await service.enableDatabase(
      'u',
      dto(BackupEngineClass.DATABASE) as any,
      {} as any,
    );
    expect(created[0].metadata.fullEveryDays).toBeUndefined();
  });

  it.each([
    [BackupEngineClass.VOLUME_COPY, DEFAULT_BACKUP_SCHEDULE.volumeCopy],
    [BackupEngineClass.PLATFORM, DEFAULT_BACKUP_SCHEDULE.platform],
    [BackupEngineClass.DATABASE, DEFAULT_BACKUP_SCHEDULE.continuousDatabase],
  ])('a %s policy runs at %s', async (engineClass, cron) => {
    const { service, created } = make();
    await service.create('u', dto(engineClass) as any);
    expect(created[0].cronSchedule).toBe(cron);
  });

  it('the schedule a person named wins', async () => {
    const { service, created } = make();
    await service.create(
      'u',
      dto(BackupEngineClass.VOLUME_COPY, '15 5 * * 0') as any,
    );
    expect(created[0].cronSchedule).toBe('15 5 * * 0');
  });

  it('the defaults never start in the same minute', () => {
    const all = Object.values(DEFAULT_BACKUP_SCHEDULE);
    expect(new Set(all).size).toBe(all.length);
  });
});
