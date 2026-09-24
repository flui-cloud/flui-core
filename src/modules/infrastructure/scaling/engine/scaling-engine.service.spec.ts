// The pending-pod reader pulls in `KubernetesService`, which imports an
// ESM-only package ts-jest cannot transform. Nothing here calls through it.
jest.mock('@kubernetes/client-node', () => ({}));

import { Repository } from 'typeorm';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../../clusters/entities/cluster-node.entity';
import {
  UnschedulablePods,
  UnschedulablePodsService,
} from '../../clusters/services/unschedulable-pods.service';
import { AvailabilityCatalogueService } from '../catalogue/availability-catalogue.service';
import { unreadCatalogue } from '../catalogue/catalogue.core';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ProviderScalingCapability } from '../scaling-capability';
import { ScalingGroupService } from '../services/scaling-group.service';
import { ShapeFact } from './engine.core';
import { ScalingEngineService } from './scaling-engine.service';
import { ShapeFactsService } from './shape-facts.service';
import { DrainFeasibilityService } from './drain-feasibility.service';

const HETZNER: ProviderScalingCapability = {
  provider: 'hetzner',
  canProvision: true,
  hasCatalogue: true,
  billing: 'hourly',
};

const CONTABO: ProviderScalingCapability = {
  provider: 'contabo',
  canProvision: false,
  hasCatalogue: true,
  billing: 'monthly',
};

const CX32: ShapeFact = {
  shape: 'cx32',
  cores: 4,
  memoryMi: 8192,
  deprecated: false,
  supportsHourlyBilling: true,
  prices: [{ region: 'fsn1', hourlyEur: 0.0074, monthlyEur: 5.4 }],
  availability: null,
};

const cluster = (over: Partial<ClusterEntity> = {}): ClusterEntity =>
  ({
    id: 'c-1',
    name: 'prod-eu',
    provider: 'hetzner',
    region: 'fsn1',
    nodeSize: 'cx32',
    nodeCount: 2,
    ...over,
  }) as ClusterEntity;

const group = (over: Partial<ScalingGroupEntity> = {}): ScalingGroupEntity =>
  ({
    id: 'g-1',
    clusterId: 'c-1',
    name: 'general',
    minNodes: 1,
    desiredNodes: 2,
    maxNodes: 5,
    regions: ['fsn1'],
    shapes: ['cx32'],
    strategy: 'closest',
    settleSeconds: 30,
    hourlyBillingOnly: false,
    maxMonthlyCost: null,
    provision: 'automatic',
    standingOrders: [],
    requirement: null,
    ...over,
  }) as ScalingGroupEntity;

const waiting = (over: Partial<UnschedulablePods> = {}): UnschedulablePods => ({
  count: 1,
  oldestWaitingSeconds: 90,
  largestRequest: {
    name: 'checkout-7d8f',
    namespace: 'flui-apps',
    cpuMillicores: 500,
    memoryMi: 4096,
  },
  message: '0/2 nodes are available: insufficient memory',
  ...over,
});

const worker = (name: string): ClusterNodeEntity =>
  ({
    id: `n-${name}`,
    clusterId: 'c-1',
    serverName: name,
    nodeType: 'worker',
    status: 'ACTIVE',
    serverType: 'cx32',
    region: 'fsn1',
    hourlyPriceEur: 0.0074,
  }) as unknown as ClusterNodeEntity;

const master = (): ClusterNodeEntity =>
  ({
    id: 'n-master',
    clusterId: 'c-1',
    serverName: 'prod-eu-master',
    nodeType: 'master',
    status: 'ACTIVE',
    serverType: 'cx32',
    region: 'fsn1',
    hourlyPriceEur: 0.0074,
  }) as unknown as ClusterNodeEntity;

const replacing = (node: string): ScalingGroupEntity =>
  group({
    desiredNodes: 3,
    standingOrders: [
      {
        kind: 'replace',
        shape: 'cx32',
        region: 'fsn1',
        wanted: 1,
        replaces: node,
      },
    ],
  });

interface Harness {
  engine: ScalingEngineService;
  pods: { read: jest.Mock };
  nodes: { find: jest.Mock };
  drain: { check: jest.Mock; roomElsewhere: jest.Mock };
}

function harness(
  capability: ProviderScalingCapability = HETZNER,
  shapes: ShapeFact[] = [CX32],
): Harness {
  const nodes = { find: jest.fn().mockResolvedValue([]) };
  const pods = { read: jest.fn().mockResolvedValue(waiting()) };
  const groups = {
    capabilityOf: jest.fn().mockReturnValue(capability),
    // Null: these fixtures fence nothing by geography, so the ladder sees the
    // regions the group and the catalogue name and no others.
    buyableFor: jest.fn().mockResolvedValue(null),
    withCluster: jest.fn(),
  };
  const catalogue = {
    read: jest
      .fn()
      .mockResolvedValue(unreadCatalogue(capability.provider, 'unreachable')),
  };
  const facts = { read: jest.fn().mockResolvedValue({ shapes, read: true }) };
  // Room by default, so the tests about what may be given back are about that;
  // the ones about room set it themselves.
  const drain = {
    check: jest.fn().mockResolvedValue(null),
    roomElsewhere: jest.fn().mockResolvedValue({
      fits: true,
      needs: { cpuMillicores: 0, memoryMi: 0 },
      room: { cpuMillicores: 4000, memoryMi: 8192 },
      stranded: [],
    }),
  };

  return {
    engine: new ScalingEngineService(
      nodes as unknown as Repository<ClusterNodeEntity>,
      groups as unknown as ScalingGroupService,
      pods as unknown as UnschedulablePodsService,
      catalogue as unknown as AvailabilityCatalogueService,
      facts as unknown as ShapeFactsService,
      drain as unknown as DrainFeasibilityService,
    ),
    pods,
    nodes,
    drain,
  };
}

describe('the settle window', () => {
  it('holds while the pod may still be caught mid-schedule', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ oldestWaitingSeconds: 12 }));

    const assessment = await h.engine.assess(group(), cluster());

    expect(assessment.outcome).toBe('declined');
    expect(assessment.did).toBe('Nothing yet.');
    expect(assessment.why).toContain('12s of the 30s');
    expect(assessment.why).toContain('really stuck');
    expect(assessment.shape).toBeNull();
  });

  it('decides once the pod has been stuck longer than the window', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ oldestWaitingSeconds: 31 }));

    const assessment = await h.engine.assess(group(), cluster());

    expect(assessment.did).toContain('Would add a cx32 in fsn1');
    expect(assessment.shape).toBe('cx32');
  });

  it('does not turn a pod it cannot date into an indefinite wait', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ oldestWaitingSeconds: null }));

    const assessment = await h.engine.assess(group(), cluster());

    expect(assessment.did).toContain('Would add');
  });
});

describe('urgency against the standing order', () => {
  const patient = () =>
    group({
      desiredNodes: 3,
      standingOrders: [
        {
          kind: 'expand',
          shape: 'cx32',
          region: 'fsn1',
          wanted: 1,
          replaces: null,
        },
      ],
    });

  it('holds the patient side down while a pod is waiting', async () => {
    const h = harness();

    const assessment = await h.engine.assess(patient(), cluster());

    expect(assessment.force).toBe('urgency');
    expect(assessment.preview.opportunityHeldBecause).toContain(
      'Urgency always wins',
    );
  });

  it('holds it down as well when the cluster could not be asked', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(null);

    const assessment = await h.engine.assess(patient(), cluster());

    expect(assessment.force).toBe('urgency');
    expect(assessment.outcome).toBe('declined');
    expect(assessment.why).toContain(
      'An unanswered cluster is not a quiet one',
    );
    expect(assessment.preview.opportunityHeldBecause).toContain(
      'could not be asked',
    );
    expect(assessment.preview.pending).toBeNull();
  });

  it('lets it run once nothing is waiting', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));

    const assessment = await h.engine.assess(patient(), cluster());

    expect(assessment.force).toBe('opportunity');
    expect(assessment.did).toContain('Would add a cx32 in fsn1');
    expect(assessment.preview.opportunityHeldBecause).toBeNull();
  });

  /**
   * An expansion is written to reach the target, and the patient side may not
   * go past it: once there, the order has nothing left to buy and is closed
   * rather than refused every minute for ever.
   */
  it('counts an expansion done once the fleet stands at its target', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));

    const assessment = await h.engine.assess(
      group({
        desiredNodes: 2,
        standingOrders: [
          {
            kind: 'expand',
            shape: 'cx32',
            region: 'fsn1',
            wanted: 1,
            replaces: null,
          },
        ],
      }),
      cluster({ nodeCount: 2 }),
    );

    expect(assessment.force).toBe('opportunity');
    expect(assessment.outcome).toBe('declined');
    expect(assessment.intent).toBeNull();
    expect(assessment.fulfilledExpansions).toBe(true);
  });

  it('keeps an expansion open while the fleet is still below its target', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));

    const assessment = await h.engine.assess(
      group({
        desiredNodes: 3,
        standingOrders: [
          {
            kind: 'expand',
            shape: 'cx32',
            region: 'fsn1',
            wanted: 1,
            replaces: null,
          },
        ],
      }),
      cluster({ nodeCount: 2 }),
    );

    expect(assessment.fulfilledExpansions).toBe(false);
  });

  it('waits rather than alarms when the shape it wants is not to be had', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    const assessment = await h.engine.assess(
      group({
        desiredNodes: 3,
        standingOrders: [
          {
            kind: 'expand',
            shape: 'cx99',
            region: 'fsn1',
            wanted: 1,
            replaces: null,
          },
        ],
      }),
      cluster(),
    );

    expect(assessment.outcome).toBe('declined');
    expect(assessment.did).toBe('Waiting.');
    expect(assessment.why).toContain('cx99');
  });

  it('lets a replacement sit one above the target, because it cannot be done otherwise', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([master(), worker('worker-2')]);
    h.drain.check.mockResolvedValue({ ok: true, blockers: [], cleared: [] });

    const assessment = await h.engine.assess(
      group({
        minNodes: 1,
        desiredNodes: 2,
        maxNodes: 3,
        standingOrders: [
          {
            kind: 'replace',
            shape: 'cx32',
            region: 'fsn1',
            wanted: 1,
            replaces: 'worker-2',
          },
        ],
      }),
      cluster(),
    );

    // Held to the target, a replacement can never take its first step: it buys
    // the stand-in before it drains the node it stands in for.
    expect(assessment.intent).toMatchObject({ kind: 'replace' });
  });

  it('says what is missing when the ceiling leaves no room to replace', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([master(), worker('worker-2')]);

    const assessment = await h.engine.assess(
      group({
        minNodes: 1,
        desiredNodes: 2,
        maxNodes: 2,
        standingOrders: [
          {
            kind: 'replace',
            shape: 'cx32',
            region: 'fsn1',
            wanted: 1,
            replaces: 'worker-2',
          },
        ],
      }),
      cluster(),
    );

    expect(assessment.intent).toBeNull();
    expect(assessment.why).toContain('leaves no room');
    // Not "the market has nothing" — the group's own ceiling is what stops it.
    expect(assessment.why).toContain('Raise the ceiling');
  });

  it('will not buy a replacement for a node this fleet does not have', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));

    const assessment = await h.engine.assess(replacing('worker-2'), cluster());

    expect(assessment.outcome).toBe('declined');
    expect(assessment.intent).toBeNull();
    expect(assessment.why).toContain('no node of this fleet goes by that name');
    // Most often the order simply outlived the replacement it asked for, and a
    // sentence that reads as a misconfiguration sends somebody looking for one.
    expect(assessment.why).toContain('already happened');
    expect(assessment.why).toContain('take it out');
  });

  it('will not buy on silence: an unanswered cluster is not an empty node', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([worker('worker-2')]);
    h.drain.check.mockResolvedValue(null);

    const assessment = await h.engine.assess(replacing('worker-2'), cluster());

    expect(assessment.intent).toBeNull();
    expect(assessment.why).toContain('could not be asked');
  });

  it('asks whether the node can be emptied before anything is bought, and names what blocks', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([worker('worker-2')]);
    h.drain.check.mockResolvedValue({
      ok: false,
      blockers: [
        {
          kind: 'dedicated-app',
          what: 'postgres-main',
          fix: 'Back it up, then redeploy it elsewhere.',
        },
      ],
      cleared: [],
    });

    const assessment = await h.engine.assess(replacing('worker-2'), cluster());

    expect(assessment.outcome).toBe('declined');
    expect(assessment.intent).toBeNull();
    expect(assessment.why).toContain('cannot be emptied');
    expect(assessment.why).toContain('postgres-main');
  });

  it('carries an intent once the node can be emptied — and still buys nothing itself', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([worker('worker-2')]);
    h.drain.check.mockResolvedValue({ ok: true, blockers: [], cleared: [] });

    const assessment = await h.engine.assess(replacing('worker-2'), cluster());

    expect(assessment.outcome).toBe('declined');
    expect(assessment.did).toContain('to replace worker-2');
    expect(assessment.intent).toMatchObject({
      kind: 'replace',
      shape: 'cx32',
      node: 'n-worker-2',
    });
    expect(assessment.why).toContain('Nothing acts on a scaling decision here');
  });
});

describe('one floor, counting the whole fleet', () => {
  it('lets the last worker go when the master alone fills the floor', async () => {
    // Two nodes against a floor of one: giving one back lands on the floor,
    // not under it. There used to be a second floor here that counted workers
    // only, and it refused this while the ceiling at the other end counted
    // every node — one number meaning two things.
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([master(), worker('worker-1')]);
    h.drain.check.mockResolvedValue({ ok: true, blockers: [], cleared: [] });

    const assessment = await h.engine.assess(
      group({ minNodes: 1, desiredNodes: 1 }),
      cluster({ minNodes: 1 }),
    );

    expect(assessment.intent).toMatchObject({ kind: 'remove' });
  });

  it('gives a node back once a worker is left over above that floor', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([
      master(),
      worker('worker-1'),
      worker('worker-2'),
    ]);
    h.drain.check.mockResolvedValue({ ok: true, blockers: [], cleared: [] });

    const assessment = await h.engine.assess(
      group({ minNodes: 1, desiredNodes: 1 }),
      cluster({ minNodes: 1 }),
    );

    expect(assessment.intent).toMatchObject({ kind: 'remove' });
  });
});

/**
 * Above the target is not the same as spare. Under steady load a fleet that
 * handed back every node it had just bought would buy it again on the next
 * tick, and pay for each turn.
 */
describe('giving back only what the fleet can do without', () => {
  const aboveTarget = () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));
    h.nodes.find.mockResolvedValue([master(), worker('worker-1')]);
    h.drain.check.mockResolvedValue({ ok: true, blockers: [], cleared: [] });
    return h;
  };

  it('keeps a node whose work would have nowhere else to run', async () => {
    const h = aboveTarget();
    h.drain.roomElsewhere.mockResolvedValue({
      fits: false,
      needs: { cpuMillicores: 3000, memoryMi: 512 },
      room: { cpuMillicores: 2430, memoryMi: 5000 },
      stranded: ['apps/heavy-1'],
    });

    const assessment = await h.engine.assess(
      group({ minNodes: 1, desiredNodes: 1 }),
      cluster({ minNodes: 1 }),
    );

    expect(assessment.intent).toBeNull();
    expect(assessment.did).toBe('Kept worker-1.');
    expect(assessment.why).toContain('apps/heavy-1 would have nowhere to run');
  });

  it('keeps it quietly — a node doing its job is not something to raise an alarm about', async () => {
    const h = aboveTarget();
    h.drain.roomElsewhere.mockResolvedValue({
      fits: false,
      needs: { cpuMillicores: 3000, memoryMi: 512 },
      room: { cpuMillicores: 100, memoryMi: 100 },
      stranded: ['apps/heavy-1'],
    });

    const assessment = await h.engine.assess(
      group({ minNodes: 1, desiredNodes: 1 }),
      cluster({ minNodes: 1 }),
    );

    expect(assessment.outcome).toBe('declined');
    expect(assessment.asks).toBeNull();
  });

  it('removes nothing on silence when the room left cannot be read', async () => {
    const h = aboveTarget();
    h.drain.roomElsewhere.mockResolvedValue(null);

    const assessment = await h.engine.assess(
      group({ minNodes: 1, desiredNodes: 1 }),
      cluster({ minNodes: 1 }),
    );

    expect(assessment.intent).toBeNull();
    expect(assessment.why).toContain('Nothing is removed on silence');
  });

  it('says it checked, when it does give a node back', async () => {
    const h = aboveTarget();

    const assessment = await h.engine.assess(
      group({ minNodes: 1, desiredNodes: 1 }),
      cluster({ minNodes: 1 }),
    );

    expect(assessment.intent).toMatchObject({ kind: 'remove' });
    expect(assessment.did).toContain(
      'whose work fits on the machines that stay',
    );
  });
});

describe('a cluster that cannot be asked', () => {
  it('still holds the floor, which is a fact about the fleet and not a reading of the cluster', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(null);
    h.nodes.find.mockResolvedValue([worker('worker-1')]);

    const assessment = await h.engine.assess(group({ minNodes: 2 }), cluster());

    expect(assessment.force).toBe('urgency');
    expect(assessment.saw).toContain('below the floor of 2');
    // It reached the ladder rather than stopping at the unanswered read.
    expect(assessment.intent).toMatchObject({ kind: 'add', shape: 'cx32' });
  });

  it('stands the patient side down when the floor is already met', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(null);
    h.nodes.find.mockResolvedValue([worker('worker-1'), worker('worker-2')]);

    const assessment = await h.engine.assess(group({ minNodes: 2 }), cluster());

    expect(assessment.did).toBe('Nothing.');
    expect(assessment.intent).toBeNull();
    expect(assessment.why).toContain('not a quiet one');
  });

  it('counts one node as a node', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(null);
    h.nodes.find.mockResolvedValue([worker('worker-1')]);

    const assessment = await h.engine.assess(group({ minNodes: 2 }), cluster());

    expect(assessment.saw).toContain('at 1 node,');
  });
});

describe('what it writes where nothing can be bought', () => {
  it('alarms with a shape and a price, and asks a person to attach it', async () => {
    const h = harness(CONTABO);

    const assessment = await h.engine.assess(
      group(),
      cluster({ provider: 'contabo' }),
    );

    expect(assessment.outcome).toBe('alerted');
    expect(assessment.asks).toContain('cx32');
    expect(assessment.asks).toContain('flui node connect');
    expect(assessment.preview.chosen).toBeNull();
  });
});

describe('the fleet it reasons over', () => {
  it('counts the node rows and the prices they carry', async () => {
    const h = harness();
    h.nodes.find.mockResolvedValue([
      { serverType: 'cx32', hourlyPriceEur: 0.0074 },
      { serverType: 'cx32', hourlyPriceEur: null },
    ]);
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));

    const assessment = await h.engine.assess(
      group({ desiredNodes: 2 }),
      cluster({ nodeCount: 99 }),
    );

    expect(assessment.saw).toContain('at 2 nodes');
  });

  it('falls back to the cluster’s own count where no node row exists', async () => {
    const h = harness();
    h.pods.read.mockResolvedValue(waiting({ count: 0, largestRequest: null }));

    const assessment = await h.engine.assess(
      group({ desiredNodes: 4 }),
      cluster({ nodeCount: 3 }),
    );

    expect(assessment.saw).toContain('at 3 nodes');
  });
});

describe('the preview', () => {
  it('answers what would happen if a node were needed right now', async () => {
    const h = harness();

    const { preview } = await h.engine.assess(group(), cluster());

    expect(preview).toMatchObject({
      groupId: 'g-1',
      pending: {
        app: 'flui-apps/checkout-7d8f',
        cpu: '500m',
        memory: '4096Mi',
      },
      chosen: { shape: 'cx32', region: 'fsn1', outcome: 'would-buy' },
      asks: null,
    });
    expect(preview.ladder.length).toBeGreaterThan(0);
  });
});

describe('what the decision says about the ceiling it cleared', () => {
  it('calls the committed figure a floor while part of the fleet has no price', async () => {
    const h = harness();
    h.nodes.find.mockResolvedValue([
      { serverType: 'cx32', hourlyPriceEur: 0.0074 },
      { serverType: 'cx32', hourlyPriceEur: null },
    ]);

    const assessment = await h.engine.assess(
      group({ maxMonthlyCost: 40 }),
      cluster(),
    );

    expect(assessment.outcome).toBe('declined');
    expect(assessment.why).toContain('1 node(s) carry no price');
    expect(assessment.why).toContain('floor');
  });

  it('says nothing of the sort where every node carries a price', async () => {
    const h = harness();
    h.nodes.find.mockResolvedValue([
      { serverType: 'cx32', hourlyPriceEur: 0.0074 },
    ]);

    const assessment = await h.engine.assess(
      group({ maxMonthlyCost: 40 }),
      cluster(),
    );

    expect(assessment.why).not.toContain('floor');
  });
});
