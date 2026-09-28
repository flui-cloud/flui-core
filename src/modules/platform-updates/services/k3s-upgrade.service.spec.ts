jest.mock('@kubernetes/client-node', () => ({}));

import { K3sUpgradeService } from './k3s-upgrade.service';
import {
  K3sClusterPort,
  K3sJobView,
  K3sNodeView,
} from '../interfaces/k3s-upgrade.interface';
import { K3sPlan, k3sPlans } from '../utils/k3s-plans.util';
import {
  K3sClusterUpgradeState,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';

const FROM = 'v1.34.6+k3s1';
const MIDDLE = 'v1.35.4+k3s1';
const TARGET = 'v1.36.2+k3s1';
const RELEASES = [
  { version: '0.13.0', k3s: { version: 'v1.34.6+k3s1' } },
  { version: '0.14.0', k3s: { version: MIDDLE } },
];

interface SimNode {
  name: string;
  server: boolean;
  version: string;
  ready: boolean;
  progress: number;
}

/**
 * A cluster as the controller would move it: once Plans exist at a version,
 * the server goes first, then each agent, two observations each. The server's
 * K3s restart takes the API away for `downTicks` observations.
 */
class SimCluster implements K3sClusterPort {
  planVersion: string | null = null;
  applied: string[] = [];
  down = 0;
  observations = 0;
  installed = true;
  failNode: string | null = null;
  stallNode: string | null = null;
  nodesSeen = 0;

  constructor(
    readonly sim: SimNode[],
    private readonly downTicks = 2,
  ) {}

  async nodes(): Promise<K3sNodeView[]> {
    this.nodesSeen++;
    if (this.down > 0) {
      this.down--;
      throw new Error('connect ECONNREFUSED');
    }
    this.advance();
    return this.sim.map((n) => ({
      name: n.name,
      server: n.server,
      kubeletVersion: n.version,
      ready: n.ready,
    }));
  }

  async jobs(): Promise<K3sJobView[]> {
    const busy = this.busy();
    if (!busy || !this.planVersion) return [];
    return [
      {
        name: `apply-${busy.name}`,
        plan: busy.server ? 'flui-k3s-server' : 'flui-k3s-agent',
        node: busy.name,
        version: this.planVersion.replace('+', '-'),
        active: busy.name !== this.failNode,
        failed: busy.name === this.failNode,
        message: busy.name === this.failNode ? 'DeadlineExceeded' : undefined,
        createdAt: new Date(0).toISOString(),
      },
    ];
  }

  async controller() {
    return { installed: this.installed, ready: this.installed };
  }

  deleted = 0;

  async deletePlans(): Promise<void> {
    this.deleted++;
    this.planVersion = null;
  }

  async applyPlans(plans: K3sPlan[]): Promise<void> {
    if (this.down > 0) throw new Error('connect ECONNREFUSED');
    this.planVersion = plans[0].spec.version as string;
    this.applied.push(this.planVersion);
  }

  private busy(): SimNode | undefined {
    if (!this.planVersion) return undefined;
    const order = [
      ...this.sim.filter((n) => n.server),
      ...this.sim.filter((n) => !n.server),
    ];
    return order.find((n) => n.version !== this.planVersion);
  }

  private advance(): void {
    const busy = this.busy();
    if (!busy || busy.name === this.failNode || busy.name === this.stallNode)
      return;
    busy.progress++;
    if (busy.progress >= 2) {
      busy.progress = 0;
      busy.version = this.planVersion as string;
      if (busy.server) this.down = this.downTicks;
    }
  }
}

function nodes(version = FROM): SimNode[] {
  return [
    { name: 'master-0', server: true, version, ready: true, progress: 0 },
    { name: 'worker-1', server: false, version, ready: true, progress: 0 },
    { name: 'worker-2', server: false, version, ready: true, progress: 0 },
  ];
}

function harness(cluster: SimCluster, metadata: Record<string, unknown> = {}) {
  let clock = Date.parse('2026-09-28T10:00:00Z');
  const operation: any = { id: 'op-1', metadata };
  const saves: K3sClusterUpgradeState[] = [];
  const operations = {
    findOne: jest.fn(async () => ({
      ...operation,
      metadata: structuredClone(operation.metadata),
    })),
    save: jest.fn(async (o: any) => {
      operation.metadata = structuredClone(o.metadata);
      saves.push(structuredClone(o.metadata.k3sUpgrades['w-1']));
      return o;
    }),
    update: jest.fn(async (_id: string, patch: any) =>
      Object.assign(operation, patch),
    ),
  };
  const recorded: string[] = [];
  const workload = {
    id: 'w-1',
    name: 'workload-cluster-2',
    clusterType: 'workload',
    kubeconfigEncrypted: 'enc',
    k3sVersion: FROM,
  };
  const control = {
    id: 'c-1',
    name: 'control-cluster',
    clusterType: 'control',
    kubeconfigEncrypted: 'enc',
    k3sVersion: FROM,
  };
  const clusters = {
    findOne: jest.fn(async (q: any) =>
      q.where.id === 'w-1' ? workload : q.where.id === 'c-1' ? control : null,
    ),
    find: jest.fn(async () => [control, workload]),
    update: jest.fn(async (_id: string, patch: any) => {
      recorded.push(patch.k3sVersion);
    }),
  };
  const service = new K3sUpgradeService(
    clusters as never,
    operations as never,
    { decrypt: () => 'kubeconfig' } as never,
    {} as never,
    {
      getManifest: async () => ({ manifest: { releases: RELEASES } }),
    } as never,
  );
  service.now = () => clock;
  service.sleep = async (ms: number) => {
    clock += ms;
  };
  jest.spyOn(service, 'clusterPort').mockReturnValue(cluster);
  return { service, operation, operations, saves, recorded, clusters };
}

describe('the K3s Plans', () => {
  it('cordons the server without draining it, and drains agents one at a time after it', () => {
    expect(k3sPlans(TARGET)).toMatchSnapshot();
  });
});

describe('planning a K3s upgrade', () => {
  it('passes through every minor a published release shipped', async () => {
    const { service } = harness(new SimCluster(nodes()));
    const [plan] = await service.plan('w-1', TARGET);
    expect(plan.observedVersion).toBe(FROM);
    expect(plan.steps).toEqual([MIDDLE, TARGET]);
    expect(plan.blockers).toEqual([]);
    expect(plan.upToDate).toBe(false);
    expect(plan.nodes.map((n) => n.role)).toEqual(['server', 'agent', 'agent']);
  });

  it('takes workload clusters before the control', async () => {
    const { service } = harness(new SimCluster(nodes()));
    const plans = await service.plan(undefined, TARGET);
    expect(plans.map((p) => p.clusterType)).toEqual(['workload', 'control']);
  });

  it('says what stops it', async () => {
    const sim = new SimCluster(nodes());
    sim.sim[2].ready = false;
    sim.installed = false;
    const { service } = harness(sim);
    const [plan] = await service.plan('w-1', 'v1.38.0+k3s1');
    expect(plan.blockers.join('\n')).toMatch(
      /No published Flui release ships K3s 1\.36/,
    );
    expect(plan.blockers.join('\n')).toMatch(/worker-2 is not Ready/);
    expect(plan.blockers.join('\n')).toMatch(
      /system-upgrade-controller is not installed/,
    );
  });

  it('is up to date when every node already runs the target', async () => {
    const sim = new SimCluster(nodes(TARGET));
    sim.installed = false;
    const { service } = harness(sim);
    const [plan] = await service.plan('w-1', TARGET);
    expect(plan.upToDate).toBe(true);
    expect(plan.blockers).toEqual([]);
  });
});

describe('running a K3s upgrade', () => {
  it('moves one minor at a time, through the server restart, and records each step', async () => {
    const sim = new SimCluster(nodes());
    const { service, recorded, saves, operation } = harness(sim);

    const state = await service.run('op-1', 'w-1', TARGET);

    expect(state.status).toBe('done');
    expect(sim.applied).toEqual([MIDDLE, TARGET]);
    expect(recorded).toEqual([MIDDLE, TARGET]);
    expect(sim.sim.every((n) => n.version === TARGET)).toBe(true);
    expect(saves.some((s) => s.unreachableSince)).toBe(true);
    expect(
      saves.some((s) => s.nodes.some((n) => n.status === 'upgrading')),
    ).toBe(true);
    expect(operation.currentStep).toBe(OperationStep.PLATFORM_UPDATE_K3S);
    expect(operation.metadata.k3sUpgrades['w-1'].nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'master-0',
          fromVersion: FROM,
          version: TARGET,
          status: 'done',
        }),
      ]),
    );
  });

  it('never advances while one node is behind', async () => {
    const sim = new SimCluster(nodes());
    sim.stallNode = 'worker-2';
    const { service, recorded, operation } = harness(sim);

    await expect(service.run('op-1', 'w-1', TARGET)).rejects.toThrow(
      /did not finish within/,
    );
    expect(recorded).toEqual([]);
    expect(sim.applied).toEqual([MIDDLE]);
    const state = operation.metadata.k3sUpgrades['w-1'];
    expect(state.status).toBe('failed');
    expect(state.stepIndex).toBe(0);
  });

  it('resumes from every state it recorded and finishes the same way', async () => {
    const reference = harness(new SimCluster(nodes()));
    await reference.service.run('op-1', 'w-1', TARGET);
    expect(reference.saves.length).toBeGreaterThan(5);

    for (const saved of reference.saves) {
      const sim = new SimCluster(
        nodes().map((n) => ({
          ...n,
          version:
            saved.nodes.find((s) => s.name === n.name)?.version ?? n.version,
        })),
      );
      const { service, recorded } = harness(sim, {
        k3sUpgrades: { 'w-1': structuredClone(saved) },
      });
      const state = await service.run('op-1', 'w-1', TARGET);

      expect(state.status).toBe('done');
      expect(sim.sim.every((n) => n.version === TARGET)).toBe(true);
      const remaining =
        saved.status === 'done' ? [] : saved.steps.slice(saved.stepIndex);
      expect(recorded).toEqual(remaining);
      for (const version of sim.applied) {
        expect(remaining).toContain(version);
      }
    }
  });

  it('does nothing on a cluster already at the target', async () => {
    const sim = new SimCluster(nodes(TARGET));
    const { service, recorded } = harness(sim);
    const state = await service.run('op-1', 'w-1', TARGET);
    expect(state.status).toBe('done');
    expect(state.steps).toEqual([]);
    expect(sim.applied).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('does not touch the cluster again once the operation recorded it done', async () => {
    const sim = new SimCluster(nodes());
    const first = harness(sim);
    await first.service.run('op-1', 'w-1', TARGET);
    const again = harness(sim, structuredClone(first.operation.metadata));
    const seen = sim.nodesSeen;
    const state = await again.service.run('op-1', 'w-1', TARGET);
    expect(state.status).toBe('done');
    expect(sim.nodesSeen).toBe(seen);
    expect(again.recorded).toEqual([]);
  });

  it('stops on a failed node job, and a later run picks the step up again', async () => {
    const sim = new SimCluster(nodes());
    sim.failNode = 'worker-1';
    const first = harness(sim);
    await expect(first.service.run('op-1', 'w-1', TARGET)).rejects.toThrow(
      /worker-1 to v1\.35\.4\+k3s1 failed: DeadlineExceeded/,
    );
    const failed = first.operation.metadata.k3sUpgrades['w-1'];
    expect(failed.status).toBe('failed');
    expect(first.recorded).toEqual([]);

    sim.failNode = null;
    const second = harness(sim, structuredClone(first.operation.metadata));
    const state = await second.service.run('op-1', 'w-1', TARGET);
    expect(state.status).toBe('done');
    expect(state.error).toBeUndefined();
    expect(second.recorded).toEqual([MIDDLE, TARGET]);
  });

  it('gives up when the API stays away', async () => {
    const sim = new SimCluster(nodes(), 1_000);
    const { service, operation, recorded } = harness(sim);
    await expect(service.run('op-1', 'w-1', TARGET)).rejects.toThrow(
      /has not answered for 10 minutes/,
    );
    expect(operation.metadata.k3sUpgrades['w-1'].status).toBe('failed');
    expect(recorded).toEqual([]);
  });

  it('refuses to start where it cannot finish', async () => {
    const sim = new SimCluster(nodes());
    sim.installed = false;
    const { service, operation } = harness(sim);
    await expect(service.run('op-1', 'w-1', TARGET)).rejects.toThrow(
      /not installed/,
    );
    expect(sim.applied).toEqual([]);
    expect(operation.metadata.k3sUpgrades['w-1'].status).toBe('failed');
  });

  it('will not switch target under a running upgrade', async () => {
    const sim = new SimCluster(nodes());
    sim.stallNode = 'master-0';
    const { service, operation } = harness(sim);
    await service.run('op-1', 'w-1', TARGET).catch(() => undefined);
    const state = operation.metadata.k3sUpgrades['w-1'];
    state.status = 'running';
    const again = harness(sim, structuredClone(operation.metadata));
    await expect(again.service.run('op-1', 'w-1', MIDDLE)).rejects.toThrow(
      /not v1\.35\.4/,
    );
  });

  it('removes both Plans once every node is at the target, so a node joining later is left alone', async () => {
    const sim = new SimCluster(nodes());
    const { service } = harness(sim);
    await service.run('op-1', 'w-1', TARGET);
    expect(sim.deleted).toBe(1);
    expect(sim.planVersion).toBeNull();
  });

  it('removes the Plans when a node fails', async () => {
    const sim = new SimCluster(nodes());
    sim.failNode = 'worker-1';
    const { service } = harness(sim);
    await expect(service.run('op-1', 'w-1', TARGET)).rejects.toThrow();
    expect(sim.deleted).toBe(1);
  });

  it('stops polling once the operation is no longer in progress', async () => {
    const sim = new SimCluster(nodes());
    sim.stallNode = 'worker-2';
    const { service, operation, operations } = harness(sim);
    operation.status = OperationStatus.IN_PROGRESS;
    let reads = 0;
    operations.findOne.mockImplementation(async () => {
      reads++;
      if (reads > 12) operation.status = OperationStatus.FAILED;
      return { ...operation, metadata: structuredClone(operation.metadata) };
    });
    await expect(service.run('op-1', 'w-1', TARGET)).rejects.toThrow(
      /no longer in progress/,
    );
    expect(sim.deleted).toBe(1);
  });
});
