import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { ScalingOverviewService } from './scaling-overview.service';
import { ScalingGroupService } from './scaling-group.service';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../entities/scaling-decision.entity';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../../clusters/entities/cluster-node.entity';
import { ProviderScalingCapability } from '../scaling-capability';
import { SCALING_ERROR } from '../scaling-errors';

const HETZNER: ProviderScalingCapability = {
  provider: 'hetzner',
  canProvision: true,
  hasCatalogue: true,
  billing: 'hourly',
};

const BYOS: ProviderScalingCapability = {
  provider: 'byos',
  canProvision: false,
  hasCatalogue: false,
  billing: 'none',
};

const cluster = (over: Partial<ClusterEntity>): ClusterEntity =>
  ({
    id: 'c-1',
    name: 'prod-eu',
    provider: 'hetzner',
    nodeCount: 2,
    nodeSize: 'cx32',
    ...over,
  }) as ClusterEntity;

const group = (over: Partial<ScalingGroupEntity> = {}): ScalingGroupEntity =>
  ({
    id: 'g-1',
    clusterId: 'c-1',
    name: 'general',
    minNodes: 1,
    desiredNodes: 3,
    maxNodes: 5,
    regions: ['fsn1'],
    shapes: ['cx23'],
    strategy: 'cheapest',
    settleSeconds: 30,
    hourlyBillingOnly: true,
    maxMonthlyCost: 40,
    provision: 'automatic',
    standingOrders: [],
    requirement: null,
    ...over,
  }) as ScalingGroupEntity;

const node = (
  hourlyPriceEur: number | null,
  over: Partial<ClusterNodeEntity> = {},
): ClusterNodeEntity =>
  ({
    id: `n-${hourlyPriceEur ?? 'x'}`,
    clusterId: 'c-1',
    serverType: 'cx32',
    hourlyPriceEur,
    ...over,
  }) as ClusterNodeEntity;

const decision = (
  over: Partial<ScalingDecisionEntity>,
): ScalingDecisionEntity =>
  ({
    id: 'd-1',
    groupId: 'g-1',
    clusterId: 'c-1',
    at: new Date('2026-08-26T07:12:00Z'),
    force: 'urgency',
    outcome: 'alerted',
    saw: '1 pod pending for 51s',
    did: 'Named a shape and raised an alarm.',
    why: 'Nothing here can create a server.',
    asks: 'Attach a machine with 2 vCPU and 8Gi free, then run flui node connect.',
    shape: null,
    region: null,
    hourlyPriceEur: null,
    considered: [],
    ...over,
  }) as ScalingDecisionEntity;

const make = (opts: {
  clusters: ClusterEntity[];
  groups?: ScalingGroupEntity[];
  /** The latest decision of each group, which is that group's current state. */
  latest?: Record<string, ScalingDecisionEntity>;
  nodes?: ClusterNodeEntity[];
  capability?: ProviderScalingCapability;
  /** What the installation granted. Absent is the default: nothing. */
  granted?: string;
}) => {
  const decisions = {
    findOne: jest.fn(async (query: { where: { groupId: string } }) => {
      return opts.latest?.[query.where.groupId] ?? null;
    }),
  };
  const service = new ScalingOverviewService(
    {
      find: jest.fn().mockResolvedValue(opts.clusters),
      findOne: jest.fn().mockResolvedValue(opts.clusters[0] ?? null),
    } as unknown as Repository<ClusterEntity>,
    {
      find: jest.fn().mockResolvedValue(opts.groups ?? []),
    } as unknown as Repository<ScalingGroupEntity>,
    decisions as unknown as Repository<ScalingDecisionEntity>,
    {
      find: jest.fn().mockResolvedValue(opts.nodes ?? []),
    } as unknown as Repository<ClusterNodeEntity>,
    {
      capabilityOf: () => opts.capability ?? HETZNER,
    } as unknown as ScalingGroupService,
    { get: () => opts.granted } as unknown as ConfigService,
  );
  return { service, decisions };
};

describe('the row a cluster gets whether or not anybody set it up', () => {
  it('says out loud that a cluster has no group', async () => {
    const { service } = make({ clusters: [cluster({})], groups: [] });
    const [row] = await service.rows();

    expect(row.groupId).toBeNull();
    expect(row.bounds).toBeNull();
    expect(row.groupCount).toBe(0);
    expect(row.groups).toEqual([]);
    expect(row.needsPerson).toContain('No scaling group');
  });

  it('asks nothing of the decisions when there is no group to have taken any', async () => {
    const { service, decisions } = make({ clusters: [cluster({})] });
    await service.rows();
    expect(decisions.findOne).not.toHaveBeenCalled();
  });

  it('stays quiet on a fleet inside its own bounds', async () => {
    const { service } = make({
      clusters: [cluster({ nodeCount: 2 })],
      groups: [group()],
    });
    const [row] = await service.rows();
    expect(row.needsPerson).toBeNull();
    expect(row.monthlyCap).toBe(40);
  });

  /** A count says a second group exists and names nothing, so reading it costs a call. */
  it('names the groups it does not lead with', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [
        group(),
        group({ id: 'g-2', name: 'heavy', provision: 'manual' }),
      ],
    });
    const [row] = await service.rows();

    expect(row.groupId).toBe('g-1');
    expect(row.groupCount).toBe(2);
    expect(row.groups).toEqual([
      {
        id: 'g-1',
        name: 'general',
        provision: 'automatic',
        bounds: { min: 1, desired: 3, max: 5 },
      },
      {
        id: 'g-2',
        name: 'heavy',
        provision: 'manual',
        bounds: { min: 1, desired: 3, max: 5 },
      },
    ]);
  });

  it('reports a floor that is not being held', async () => {
    const { service } = make({
      clusters: [cluster({ nodeCount: 2 })],
      groups: [group({ minNodes: 3 })],
    });
    const [row] = await service.rows();
    expect(row.needsPerson).toContain('Below its floor — 2 nodes where 3');
  });

  /**
   * On a cluster nothing can buy for, the ceiling never refused those machines
   * — a person attached them. It can report and nothing else, and the sentence
   * has to say so or it reads as a rule that failed.
   */
  it('reports a ceiling it could not have enforced', async () => {
    const { service } = make({
      clusters: [cluster({ provider: 'byos', nodeCount: 6 })],
      groups: [group({ maxNodes: 5, provision: 'manual' })],
      capability: BYOS,
    });
    const [row] = await service.rows();
    expect(row.needsPerson).toContain('Nothing refused them');
  });

  it('keeps a ceiling report plain where the ceiling can act', async () => {
    const { service } = make({
      clusters: [cluster({ nodeCount: 6 })],
      groups: [group({ maxNodes: 5 })],
    });
    const [row] = await service.rows();
    expect(row.needsPerson).toBe('6 nodes against a ceiling of 5.');
  });

  /**
   * `max: 0` is the reading a manual group takes of a fleet that should hold
   * nothing: every machine on it is one somebody attached.
   */
  it('takes a ceiling of zero as a statement about the fleet', async () => {
    const { service } = make({
      clusters: [cluster({ provider: 'byos', nodeCount: 1 })],
      groups: [
        group({
          minNodes: 0,
          desiredNodes: 0,
          maxNodes: 0,
          provision: 'manual',
        }),
      ],
      capability: BYOS,
    });
    const [row] = await service.rows();
    expect(row.bounds).toEqual({ min: 0, desired: 0, max: 0 });
    expect(row.needsPerson).toContain('1 nodes against a ceiling of 0');
  });
});

describe('what a fleet costs, and what it cannot be said to cost', () => {
  it('adds up a fleet whose nodes all carry a price', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group()],
      nodes: [node(0.02), node(0.01)],
    });
    const [row] = await service.rows();

    expect(row.nodes).toBe(2);
    expect(row.monthlyEur).toBe(21.9);
    expect(row.unpricedNodes).toBe(0);
  });

  /**
   * The failure this guards against is silent: summing the priced nodes and
   * saying nothing draws a fleet cheaper than the bill, and the number nobody
   * questions is the one that looks exact.
   */
  it('reads a partly priced fleet as a floor, and counts what it left out', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group()],
      nodes: [node(0.02), node(null)],
    });
    const [row] = await service.rows();

    expect(row.nodes).toBe(2);
    expect(row.monthlyEur).toBe(14.6);
    expect(row.unpricedNodes).toBe(1);
  });

  it('shows no cost rather than a zero when no node carries a price', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group()],
      nodes: [node(null), node(null)],
    });
    const [row] = await service.rows();

    expect(row.monthlyEur).toBeNull();
    expect(row.unpricedNodes).toBe(2);
  });

  it('falls back to the cluster’s own count where no node was ever recorded', async () => {
    const { service } = make({
      clusters: [cluster({ nodeCount: 3 })],
      groups: [group()],
      nodes: [],
    });
    const [row] = await service.rows();

    expect(row.nodes).toBe(3);
    expect(row.monthlyEur).toBeNull();
    expect(row.unpricedNodes).toBe(3);
  });

  /** Flui never sees a bill for the operator's own machines, priced row or not. */
  it('shows no cost on a provider that bills nobody, even with a price on the node', async () => {
    const { service } = make({
      clusters: [cluster({ provider: 'byos' })],
      groups: [group({ provision: 'manual' })],
      capability: BYOS,
      nodes: [node(0.02), node(0.02)],
    });
    const [row] = await service.rows();
    expect(row.monthlyEur).toBeNull();
  });

  it('says a fleet is over its ceiling only when it is sure of it', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group({ maxMonthlyCost: 40 })],
      nodes: [node(0.03), node(0.03)],
    });
    const [row] = await service.rows();
    expect(row.monthlyEur).toBe(43.8);
    expect(row.needsPerson).toBe('Over its own ceiling of €40 a month.');
  });

  it('says the figure it went over the ceiling with is a floor', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group({ maxMonthlyCost: 40 })],
      nodes: [node(0.03), node(0.03), node(null)],
    });
    const [row] = await service.rows();
    expect(row.needsPerson).toContain('is a floor — 1 node(s) carry no price');
  });
});

/**
 * The alarm is the group's current state, read off its latest decision. Looking
 * instead for a later `added` left it standing for good, because nothing writes
 * one — on exactly the providers where the alarm is the entire product.
 */
describe('an alarm nobody has acted on', () => {
  it('stands while it is the last thing the group decided', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group()],
      latest: { 'g-1': decision({}) },
    });
    const [row] = await service.rows();

    expect(row.openAlarm).toEqual({
      since: '2026-08-26T07:12:00.000Z',
      asks: 'Attach a machine with 2 vCPU and 8Gi free, then run flui node connect.',
    });
    expect(row.needsPerson).toContain('2026-08-26');
    expect(row.lastDecisionAt).toBe('2026-08-26T07:12:00.000Z');
  });

  it('is gone once the group has decided anything else', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group()],
      latest: {
        'g-1': decision({
          at: new Date('2026-08-26T09:00:00Z'),
          outcome: 'declined',
          asks: null,
        }),
      },
    });
    const [row] = await service.rows();

    expect(row.openAlarm).toBeNull();
    expect(row.needsPerson).toBeNull();
    expect(row.lastDecisionAt).toBe('2026-08-26T09:00:00.000Z');
  });

  /**
   * Nothing adds a node here, so a machine attached by hand reaches the registry
   * only as the decline the next pass writes.
   */
  it('is cleared by the decline that follows a machine attached by hand', async () => {
    const { service } = make({
      clusters: [cluster({ provider: 'byos', nodeCount: 3 })],
      groups: [group({ provision: 'manual' })],
      capability: BYOS,
      latest: {
        'g-1': decision({
          at: new Date('2026-08-26T09:30:00Z'),
          outcome: 'declined',
          did: 'Nothing.',
          why: 'The fleet is at its target and no standing order is open.',
          asks: null,
        }),
      },
    });
    const [row] = await service.rows();
    expect(row.openAlarm).toBeNull();
    expect(row.needsPerson).toBeNull();
  });

  it('holds an alarm raised by a second group, and shows the one standing longest', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group(), group({ id: 'g-2', name: 'heavy' })],
      latest: {
        'g-1': decision({
          at: new Date('2026-08-26T10:00:00Z'),
          outcome: 'declined',
          asks: null,
        }),
        'g-2': decision({
          id: 'd-2',
          groupId: 'g-2',
          at: new Date('2026-08-26T08:00:00Z'),
          asks: 'Attach a machine holding 4 vCPU.',
        }),
      },
    });
    const [row] = await service.rows();

    expect(row.openAlarm?.asks).toBe('Attach a machine holding 4 vCPU.');
    expect(row.openAlarm?.since).toBe('2026-08-26T08:00:00.000Z');
    expect(row.lastDecisionAt).toBe('2026-08-26T10:00:00.000Z');
  });
});

describe('whether the cluster will actually be given a node', () => {
  it('does not claim a cluster buys while nothing was granted to the installation', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group({ provision: 'automatic' })],
    });
    const [row] = await service.rows();

    expect(row.capability.canProvision).toBe(true);
    expect(row.acts).toBe(false);
  });

  it('does not claim it buys while every group is set only to decide', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group({ provision: 'manual' })],
      granted: '40',
    });
    const [row] = await service.rows();

    expect(row.acts).toBe(false);
  });

  it('says it buys once the group is set to act and the grant is there', async () => {
    const { service } = make({
      clusters: [cluster({})],
      groups: [group({ provision: 'automatic' })],
      granted: '40',
    });
    const [row] = await service.rows();

    expect(row.acts).toBe(true);
  });

  it('never says it buys where nothing can create a server', async () => {
    const { service } = make({
      clusters: [cluster({ provider: 'byos' })],
      groups: [group({ provision: 'automatic' })],
      granted: '40',
      capability: {
        provider: 'byos',
        canProvision: false,
        hasCatalogue: false,
        billing: 'none',
      },
    });
    const [row] = await service.rows();

    expect(row.acts).toBe(false);
  });
});

describe('one cluster on its own', () => {
  it('answers 404 for a cluster that is not there, and says which 404 it is', async () => {
    const service = new ScalingOverviewService(
      {
        findOne: jest.fn().mockResolvedValue(null),
      } as unknown as Repository<ClusterEntity>,
      { find: jest.fn() } as unknown as Repository<ScalingGroupEntity>,
      {} as unknown as Repository<ScalingDecisionEntity>,
      {} as unknown as Repository<ClusterNodeEntity>,
      {} as unknown as ScalingGroupService,
      {} as unknown as ConfigService,
    );

    await expect(service.rowFor('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await service.rowFor('nope').catch((error: NotFoundException) => {
      expect(error.getResponse()).toMatchObject({
        code: SCALING_ERROR.CLUSTER_NOT_FOUND,
      });
    });
  });
});
