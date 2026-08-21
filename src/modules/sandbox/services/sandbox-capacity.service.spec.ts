// Reading cluster capacity pulls in the Kubernetes client, which is ESM-only
// and beyond what ts-jest transforms. Every call here is stubbed, so nothing
// from it is ever constructed.
jest.mock('@kubernetes/client-node', () => ({}));

import { SandboxCapacityService } from './sandbox-capacity.service';
import { SandboxTenantState } from '../entities/sandbox-tenant.entity';
import { loadSandboxConfig } from '../sandbox.config';

/**
 * The arithmetic that decides whether a visitor waits two minutes or three
 * seconds. It replaced a number somebody typed, so it is worth more tests than
 * the number ever had.
 */

const config = loadSandboxConfig({
  SANDBOX_ENABLED: 'true',
  SANDBOX_CLUSTER_ID: 'cluster-1',
  SANDBOX_ALLOW_MASTER_PLACEMENT: 'true',
} as NodeJS.ProcessEnv);

interface World {
  warm?: number;
  live?: number;
  claimsLastHour?: number;
  claimsLastDay?: number;
  /** Millicores and MiB free across the nodes a tenancy may land on. */
  freeCpu?: number;
  freeMemory?: number;
  /** Per-tenancy requests the pods report. */
  podCpu?: string;
  podMemory?: string;
  clusterUnreadable?: boolean;
}

/** How many times the cluster was asked anything, so caching can be asserted. */
let clusterReads = 0;

const build = (world: World = {}) => {
  clusterReads = 0;
  const warm = world.warm ?? 0;
  const live = world.live ?? 0;

  const tenants = {
    count: async ({ where }: { where: Record<string, unknown> }) => {
      if ('claimedAt' in where) {
        // The service asks for one hour first, then one day.
        const asked = (where.claimedAt as { value: Date }).value;
        const hours = (Date.now() - asked.getTime()) / 3_600_000;
        return hours <= 1.5
          ? (world.claimsLastHour ?? 0)
          : (world.claimsLastDay ?? 0);
      }
      return where.state === SandboxTenantState.READY ? warm : live;
    },
    find: async () =>
      Array.from({ length: warm + live }, (_, i) => ({
        namespace: `user-guest-${i}`,
      })),
  };

  const clusters = {
    findOne: async () =>
      world.clusterUnreadable ? null : { kubeconfigEncrypted: 'sealed' },
  };

  const k8s = {
    listResources: async () => [
      {
        spec: {
          containers: [
            {
              resources: {
                requests: {
                  cpu: world.podCpu ?? '500m',
                  memory: world.podMemory ?? '512Mi',
                },
              },
            },
          ],
        },
      },
    ],
    parseCpu: (v: string) =>
      v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000,
    parseMemory: (v: string) => Number(v.replace('Mi', '')),
    listWorkerNodeCapacities: async () => {
      clusterReads += 1;
      return [];
    },
    getMasterNodeCapacity: async () => ({
      nodeName: 'master',
      allocatable: {
        cpu: world.freeCpu ?? 4000,
        memory: world.freeMemory ?? 8192,
      },
      requested: { cpu: 0, memory: 0 },
    }),
  };

  const encryption = { decrypt: () => 'kubeconfig' };

  return new SandboxCapacityService(
    tenants as never,
    clusters as never,
    k8s as never,
    encryption as never,
    config,
  );
};

describe('how many tenancies to keep warm', () => {
  /**
   * The floor. A demo with no visitors still has a first visitor, and making
   * that one person wait two minutes is the whole failure this exists to avoid.
   */
  it('keeps one warm when nobody has come all day', async () => {
    const snapshot = await build({ warm: 0, live: 0 }).snapshot();
    expect(snapshot.demandPerHour).toBe(0);
    expect(snapshot.target).toBe(1);
  });

  it('covers the visitors expected while a replacement is being built', async () => {
    // 30 an hour against a ~200s build is about 1.7 arrivals per build.
    const snapshot = await build({ claimsLastHour: 30, live: 1 }).snapshot();
    expect(snapshot.demandPerHour).toBe(30);
    expect(snapshot.target).toBe(3);
  });

  it('reacts to a burst in the last hour rather than to the daily average', async () => {
    const quiet = await build({
      claimsLastHour: 0,
      claimsLastDay: 24,
    }).snapshot();
    const busy = await build({
      claimsLastHour: 30,
      claimsLastDay: 24,
    }).snapshot();

    expect(quiet.demandPerHour).toBe(1);
    expect(busy.demandPerHour).toBe(30);
    expect(busy.target).toBeGreaterThan(quiet.target);
  });

  // Otherwise a quiet hour after a busy day would empty the buffer just as the
  // next day's traffic arrives.
  it('does not forget a busy day during one quiet hour', async () => {
    const snapshot = await build({
      claimsLastHour: 0,
      claimsLastDay: 240,
    }).snapshot();
    expect(snapshot.demandPerHour).toBe(10);
  });
});

describe('the ceiling', () => {
  it('is what the cluster has room for, not what was asked for', async () => {
    // 1500m free at 500m each is three more, on top of the two that exist.
    const snapshot = await build({
      warm: 1,
      live: 1,
      claimsLastHour: 500,
      freeCpu: 1500,
      freeMemory: 999_999,
    }).snapshot();

    expect(snapshot.ceiling).toBe(5);
    expect(snapshot.target).toBe(4);
  });

  it('is bound by whichever of cpu and memory runs out first', async () => {
    const snapshot = await build({
      claimsLastHour: 500,
      freeCpu: 10_000,
      freeMemory: 1024,
    }).snapshot();

    expect(snapshot.ceiling).toBe(2);
  });

  /**
   * A cluster that cannot be read is not a cluster with no room. Refusing to
   * build on a transient API error would drain the buffer over a blip and make
   * every visitor wait for a build.
   */
  it('holds what exists when the cluster cannot be read, and says so', async () => {
    const snapshot = await build({
      warm: 2,
      live: 1,
      claimsLastHour: 100,
      clusterUnreadable: true,
    }).snapshot();

    expect(snapshot.ceiling).toBe(3);
    expect(snapshot.footprint.source).toBe('declared');
    expect(snapshot.reason).toContain('could not be read');
  });

  it('never asks for more than the room left over the tenancies in use', async () => {
    const snapshot = await build({
      warm: 0,
      live: 4,
      claimsLastHour: 500,
      freeCpu: 500,
      freeMemory: 999_999,
    }).snapshot();

    expect(snapshot.ceiling).toBe(5);
    expect(snapshot.target).toBe(1);
    expect(snapshot.reason).toContain('full');
  });
});

describe('what the rule measures rather than assumes', () => {
  it('measures the footprint from the tenancies that exist', async () => {
    const snapshot = await build({
      warm: 2,
      podCpu: '250m',
      podMemory: '300Mi',
    }).snapshot();

    expect(snapshot.footprint).toMatchObject({
      cpu: 250,
      memory: 300,
      source: 'measured',
      sampledFrom: 2,
    });
  });

  it('falls back to the declared footprint before any tenancy exists', async () => {
    const snapshot = await build({ warm: 0, live: 0 }).snapshot();
    expect(snapshot.footprint).toMatchObject({ source: 'declared', cpu: 500 });
  });

  it('starts from the measured build time and then believes what it sees', async () => {
    const service = build();
    expect(service.readySeconds()).toBe(202);

    service.recordBuild(300);
    service.recordBuild(320);
    service.recordBuild(310);
    expect(service.readySeconds()).toBe(386);
  });

  // One slow image pull must not double the buffer for the rest of the day.
  it('takes the median build, so one bad build does not move it', async () => {
    const service = build();
    service.recordBuild(120);
    service.recordBuild(126);
    service.recordBuild(1200);
    expect(service.readySeconds()).toBe(202);
  });

  it('ignores a build time that is not a number of seconds', async () => {
    const service = build();
    service.recordBuild(Number.NaN);
    service.recordBuild(-5);
    expect(service.readySeconds()).toBe(202);
  });
});

describe('being told the door was closed', () => {
  it('counts refusals, which leave no other trace', async () => {
    const service = build();
    expect((await service.snapshot()).fullRefusals).toBe(0);

    service.recordFullRefusal();
    service.recordFullRefusal();
    expect((await service.snapshot()).fullRefusals).toBe(2);
  });

  /**
   * The moment this is asked most is a rush — every refused visitor asks it to
   * be told when to come back — which is the worst moment to also be listing
   * every node and pod once per refusal.
   */
  it('does not re-read the cluster for every visitor turned away', async () => {
    const service = build({ warm: 1 });
    await service.snapshot();
    await service.snapshot();
    await service.snapshot();
    expect(clusterReads).toBe(1);
  });

  it('re-reads as soon as a build has changed the answer', async () => {
    const service = build({ warm: 1 });
    await service.snapshot();
    service.recordBuild(130);
    await service.snapshot();
    expect(clusterReads).toBe(2);
  });
});

describe('what to build right now', () => {
  it('is the gap between what is warm and what is wanted', async () => {
    expect(
      await build({ warm: 0, claimsLastHour: 30, live: 1 }).missing(),
    ).toBe(3);
    expect(
      await build({ warm: 3, claimsLastHour: 30, live: 1 }).missing(),
    ).toBe(0);
  });

  it('never asks for a negative number of builds', async () => {
    expect(await build({ warm: 9, claimsLastHour: 0 }).missing()).toBe(0);
  });
});
