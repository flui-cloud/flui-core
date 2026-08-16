import { SandboxReserveService } from './sandbox-reserve.service';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { loadSandboxConfig } from '../sandbox.config';

/**
 * The claim is the one place where being sloppy costs money or, worse, hands two
 * visitors the same tenancy. These tests drive the repository through the exact
 * shapes the service uses, including a lost race.
 */

const config = loadSandboxConfig({
  SANDBOX_ENABLED: 'true',
  SANDBOX_TTL_HOURS: '24',
  SANDBOX_RESERVE_SIZE: '3',
  SANDBOX_MAX_CLAIMS_PER_IP: '2',
} as NodeJS.ProcessEnv);

const tenant = (over: Partial<SandboxTenantEntity>): SandboxTenantEntity =>
  ({
    id: 'a',
    state: SandboxTenantState.READY,
    namespace: 'guest-a',
    clusterId: 'c1',
    userId: 'u-a',
    email: 'guest-a@try.flui.cloud',
    createdAt: new Date('2026-01-01'),
    ...over,
  }) as SandboxTenantEntity;

type RepoOverrides = {
  ready?: SandboxTenantEntity[];
  /** How many rows each conditional UPDATE claims to have touched. */
  affected?: number[];
  recentClaims?: number;
};

const repoWith = (over: RepoOverrides) => {
  const ready = [...(over.ready ?? [])];
  const affected = [...(over.affected ?? [])];
  const updates: Array<Record<string, unknown>> = [];

  return {
    updates,
    repo: {
      findOne: async () => ready.shift() ?? null,
      findOneByOrFail: async ({ id }: { id: string }) => tenant({ id }),
      find: async () => [],
      createQueryBuilder: () => {
        const qb: Record<string, any> = {};
        qb.where = () => qb;
        qb.andWhere = () => qb;
        qb.getCount = async () => over.recentClaims ?? 0;
        qb.update = () => qb;
        qb.set = (values: Record<string, unknown>) => {
          updates.push(values);
          return qb;
        };
        qb.execute = async () => ({ affected: affected.shift() ?? 1 });
        qb.select = () => qb;
        qb.addSelect = () => qb;
        qb.groupBy = () => qb;
        qb.getRawMany = async () => [];
        return qb;
      },
    },
  };
};

describe('SandboxReserveService.claim', () => {
  it('hands out a tenancy and starts the clock now, not when it was built', async () => {
    const { repo } = repoWith({ ready: [tenant({ id: 'a' })] });
    const service = new SandboxReserveService(repo as never, config);

    const before = Date.now();
    const { expiresAt } = await service.claim('1.2.3.4');

    const hours = (expiresAt.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  // Two visitors, one row: the conditional UPDATE decides, and the loser moves
  // on to the next tenancy instead of receiving the same one.
  it('moves to the next tenancy when it loses the race for one', async () => {
    const { repo, updates } = repoWith({
      ready: [tenant({ id: 'a' }), tenant({ id: 'b' })],
      affected: [0, 1],
    });
    const service = new SandboxReserveService(repo as never, config);

    await expect(service.claim('1.2.3.4')).resolves.toBeTruthy();
    expect(updates).toHaveLength(2);
  });

  it('refuses rather than inventing a tenancy when the reserve is empty', async () => {
    const { repo } = repoWith({ ready: [] });
    const service = new SandboxReserveService(repo as never, config);

    await expect(service.claim('1.2.3.4')).rejects.toMatchObject({
      response: { code: 'SANDBOX_FULL' },
    });
  });

  it('gives up after a bounded number of lost races', async () => {
    const { repo, updates } = repoWith({
      ready: Array.from({ length: 20 }, (_, i) => tenant({ id: `t${i}` })),
      affected: Array.from({ length: 20 }, () => 0),
    });
    const service = new SandboxReserveService(repo as never, config);

    await expect(service.claim('1.2.3.4')).rejects.toMatchObject({
      response: { code: 'SANDBOX_FULL' },
    });
    expect(updates.length).toBeLessThanOrEqual(5);
  });

  it('stops an address that has already had its share today', async () => {
    const { repo } = repoWith({ ready: [tenant({})], recentClaims: 2 });
    const service = new SandboxReserveService(repo as never, config);

    await expect(service.claim('1.2.3.4')).rejects.toMatchObject({
      response: { code: 'SANDBOX_CLAIM_LIMIT' },
    });
  });

  it('records the claimant as a hash, never as an address', async () => {
    const { repo, updates } = repoWith({ ready: [tenant({})] });
    const service = new SandboxReserveService(repo as never, config);

    await service.claim('203.0.113.9');

    const written = JSON.stringify(updates[0]);
    expect(written).not.toContain('203.0.113.9');
    expect(updates[0].claimIpHash).toHaveLength(32);
  });

  // Found live: a tenancy that broke while being built held a namespace and an
  // identity-provider account that neither the expiry nor the unclaimed sweep
  // would ever collect.
  it('collects what broke while being built, and what got stuck building', async () => {
    const seen: unknown[] = [];
    const repo = {
      find: async (query: unknown) => {
        seen.push(query);
        return [];
      },
    };
    const service = new SandboxReserveService(repo as never, config);

    await service.findAbandoned();

    const where = (seen[0] as { where: Array<{ state: string }> }).where;
    expect(where.map((w) => w.state)).toEqual(['failed', 'provisioning']);
  });

  it('buckets the same address to the same hash and different ones apart', () => {
    const { repo } = repoWith({});
    const service = new SandboxReserveService(repo as never, config);

    expect(service.hashIp('1.1.1.1')).toBe(service.hashIp('1.1.1.1'));
    expect(service.hashIp('1.1.1.1')).not.toBe(service.hashIp('1.1.1.2'));
  });
});

describe('sandbox configuration', () => {
  it('is off unless it is switched on explicitly', () => {
    expect(loadSandboxConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  // Closing the door and evicting the people inside are different actions, and
  // an incident needs the first without the second.
  it('keeps "stop new visitors" separate from "shut it down"', () => {
    const closed = loadSandboxConfig({
      SANDBOX_ENABLED: 'true',
      SANDBOX_ACCEPTING_CLAIMS: 'false',
    } as NodeJS.ProcessEnv);
    expect(closed.enabled).toBe(true);
    expect(closed.acceptingClaims).toBe(false);
  });

  it('falls back to sane numbers when the environment says something silly', () => {
    const cfg = loadSandboxConfig({
      SANDBOX_TTL_HOURS: 'banana',
      SANDBOX_RESERVE_SIZE: '-4',
    } as NodeJS.ProcessEnv);
    expect(cfg.ttlHours).toBe(24);
    expect(cfg.reserveSize).toBe(5);
  });
});
