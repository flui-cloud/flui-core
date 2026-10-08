import { SandboxReserveService } from './sandbox-reserve.service';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { loadSandboxConfig } from '../sandbox.config';

const config = loadSandboxConfig({
  SANDBOX_ENABLED: 'true',
  SANDBOX_TTL_HOURS: '24',
} as NodeJS.ProcessEnv);

/** The arithmetic has its own tests; here it only has to answer. */
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

describe('SandboxReserveService.findAbandoned', () => {
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
      SANDBOX_WORKLOAD_TTL_HOURS: '',
    } as NodeJS.ProcessEnv);
    expect(cfg.ttlHours).toBe(24 * 7);
    expect(cfg.workloadTtlHours).toBe(24);
  });

  // Two clocks, and the shorter one belongs to the half that costs: an account
  // holds a namespace under a quota, a running workload holds memory and CPU.
  it('lets the account outlive what the guest deployed', () => {
    const cfg = loadSandboxConfig({} as NodeJS.ProcessEnv);
    expect(cfg.workloadTtlMs).toBeLessThan(cfg.ttlMs);
  });
});

/**
 * Seven rows once spent a week failing on the same missing kubeconfig, once a
 * minute, writing the same line. Retrying forever is not resilience — it is a
 * log that nobody can read any more.
 */
describe('SandboxReserveService.markFailed', () => {
  const repoRemembering = (initial: Partial<SandboxTenantEntity>) => {
    let row = tenant({ id: 'a', ...initial });
    const writes: Array<Record<string, unknown>> = [];
    return {
      writes,
      current: () => row,
      repo: {
        findOne: async () => row,
        update: async (_id: string, values: Record<string, unknown>) => {
          writes.push(values);
          row = tenant({ ...row, ...values } as Partial<SandboxTenantEntity>);
          return { affected: 1 };
        },
      },
    };
  };

  const serviceOn = (repo: unknown) =>
    new SandboxReserveService(repo as never, config);

  it('counts repeats of the same error and eventually stops sweeping the row', async () => {
    const { repo, current } = repoRemembering({
      lastError: null,
      reapAttempts: 0,
    });
    const service = serviceOn(repo);

    await service.markFailed('a', 'namespace: no kubeconfig');
    expect(current().state).toBe(SandboxTenantState.FAILED);
    expect(current().reapAttempts).toBe(1);

    await service.markFailed('a', 'namespace: no kubeconfig');
    expect(current().state).toBe(SandboxTenantState.FAILED);

    await service.markFailed('a', 'namespace: no kubeconfig');
    expect(current().state).toBe(SandboxTenantState.NEEDS_ATTENTION);
    expect(current().reapAttempts).toBe(3);
  });

  // A different failure means something moved, and the next attempt is not the
  // same attempt.
  it('starts counting again when the error changes', async () => {
    const { repo, current } = repoRemembering({
      lastError: 'namespace: no kubeconfig',
      reapAttempts: 2,
    });
    const service = serviceOn(repo);

    await service.markFailed('a', 'idp user: provider timed out');

    expect(current().reapAttempts).toBe(1);
    expect(current().state).toBe(SandboxTenantState.FAILED);
  });

  // The sweep selects on `failed`; a parked row must not be selected by it.
  it('parks the row in a state the sweep does not pick up', async () => {
    const { repo, current } = repoRemembering({
      lastError: 'namespace: no kubeconfig',
      reapAttempts: 2,
    });
    await serviceOn(repo).markFailed('a', 'namespace: no kubeconfig');

    expect(current().state).not.toBe(SandboxTenantState.FAILED);
    expect(current().state).toBe(SandboxTenantState.NEEDS_ATTENTION);
  });
});
