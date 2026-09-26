// The engine reaches the pending-pod reader, which imports an ESM-only package
// ts-jest cannot transform. Nothing here calls through it.
jest.mock('@kubernetes/client-node', () => ({}));
// And the actuator reaches the service that buys, which reaches the VNet maths
// and an ESM-only CIDR package. Nothing here calls through either.
jest.mock('ip-cidr', () => ({}));

import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../entities/scaling-decision.entity';
import {
  ScalingAssessment,
  ScalingEngineService,
} from './scaling-engine.service';
import { ScalingReconcilerService } from './scaling-reconciler.service';
import { ScalingAlarmService } from './scaling-alarm.service';
import { ScalingActuatorService } from './scaling-actuator.service';

const group = { id: 'g-1', clusterId: 'c-1' } as ScalingGroupEntity;
const cluster = {
  id: 'c-1',
  provider: 'hetzner',
  status: ClusterStatus.READY,
} as ClusterEntity;

const assessment = (over: Partial<ScalingAssessment> = {}): ScalingAssessment =>
  ({
    groupId: 'g-1',
    clusterId: 'c-1',
    force: 'urgency',
    outcome: 'declined',
    saw: '1 pod pending',
    did: 'Would add a cx32 in fsn1.',
    why: 'Nothing acts on a scaling decision here.',
    asks: null,
    shape: 'cx32',
    region: 'fsn1',
    hourlyEur: 0.0074,
    considered: [],
    intent: null,
    drain: null,
    preview: {
      groupId: 'g-1',
      pending: null,
      opportunityHeldBecause: null,
      ladder: [],
      chosen: null,
      asks: null,
    },
    ...over,
  }) as ScalingAssessment;

function harness(last: ScalingDecisionEntity | null = null) {
  const decisions = {
    findOne: jest.fn().mockResolvedValue(last),
    create: jest.fn((row: unknown) => row),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const engine = { assess: jest.fn().mockResolvedValue(assessment()) };
  // Nothing acts in these: the reconciler's own job is what is under test, and
  // an actuator that returns null is exactly a provider Flui cannot buy from.
  const actuator = { act: jest.fn().mockResolvedValue(null) };
  const alarms = { publish: jest.fn().mockResolvedValue(undefined) };
  const groups = {
    find: jest.fn().mockResolvedValue([group]),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ScalingReconcilerService(
    groups as unknown as Repository<ScalingGroupEntity>,
    {
      find: jest.fn().mockResolvedValue([cluster]),
    } as unknown as Repository<ClusterEntity>,
    decisions as unknown as Repository<ScalingDecisionEntity>,
    engine as unknown as ScalingEngineService,
    actuator as unknown as ScalingActuatorService,
    alarms as unknown as ScalingAlarmService,
    { ring: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, decisions, engine, actuator, alarms, groups };
}

describe('a cluster on its way out', () => {
  it('is skipped, so a tick cannot leave a decision behind a teardown', async () => {
    const decisions = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const engine = { assess: jest.fn() };
    // The deletion sweeps the groups; a cluster already filtered out here is
    // one whose groups a pass can no longer write about.
    const clusters = { find: jest.fn().mockResolvedValue([]) };

    const alarms = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new ScalingReconcilerService(
      {
        find: jest.fn().mockResolvedValue([group]),
      } as unknown as Repository<ScalingGroupEntity>,
      clusters as unknown as Repository<ClusterEntity>,
      decisions as unknown as Repository<ScalingDecisionEntity>,
      engine as unknown as ScalingEngineService,
      { act: jest.fn() } as unknown as ScalingActuatorService,
      { publish: jest.fn() } as unknown as ScalingAlarmService,
      { ring: jest.fn().mockResolvedValue(undefined) } as never,
    );

    expect(await service.reconcileAll()).toBe(0);
    expect(engine.assess).not.toHaveBeenCalled();
    expect(decisions.save).not.toHaveBeenCalled();
  });
});

describe('the reconciler', () => {
  it('writes down what it decided', async () => {
    const h = harness();

    expect(await h.service.reconcileAll()).toBe(1);
    expect(h.decisions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'g-1',
        clusterId: 'c-1',
        force: 'urgency',
        outcome: 'declined',
        shape: 'cx32',
        hourlyPriceEur: 0.0074,
      }),
    );
  });

  it('does not repeat an answer that has not changed', async () => {
    const h = harness({
      at: new Date(),
      force: 'urgency',
      outcome: 'declined',
      why: 'Nothing acts on a scaling decision here.',
      shape: 'cx32',
      region: 'fsn1',
    } as ScalingDecisionEntity);

    expect(await h.service.reconcileAll()).toBe(0);
    expect(h.decisions.save).not.toHaveBeenCalled();
  });

  it('writes again when the answer changes', async () => {
    const h = harness({
      at: new Date(),
      force: 'urgency',
      outcome: 'alerted',
      why: 'Nothing acts on a scaling decision here.',
      shape: 'cx32',
      region: 'fsn1',
    } as ScalingDecisionEntity);

    expect(await h.service.reconcileAll()).toBe(1);
  });

  it('says the same thing again once the row has aged', async () => {
    const h = harness({
      at: new Date(Date.now() - 2 * 3600 * 1000),
      force: 'urgency',
      outcome: 'declined',
      why: 'Nothing acts on a scaling decision here.',
      shape: 'cx32',
      region: 'fsn1',
    } as ScalingDecisionEntity);

    expect(await h.service.reconcileAll()).toBe(1);
  });

  it('keeps one group’s failure from stopping the rest', async () => {
    const h = harness();
    h.engine.assess.mockRejectedValueOnce(new Error('cluster unreachable'));

    expect(await h.service.reconcileAll()).toBe(0);
  });
});

describe('an expansion the fleet has fulfilled', () => {
  const withOrders = {
    ...group,
    standingOrders: [
      {
        kind: 'expand',
        shape: 'cx32',
        region: 'fsn1',
        wanted: 1,
        replaces: null,
      },
      {
        kind: 'replace',
        shape: 'cx32',
        region: 'fsn1',
        wanted: 1,
        replaces: 'n-1',
      },
    ],
  } as unknown as ScalingGroupEntity;

  it('is closed, and a replacement still waiting is kept', async () => {
    const h = harness();
    h.engine.assess.mockResolvedValue(
      assessment({ fulfilledExpansions: true }),
    );

    await h.service.reconcile(withOrders, cluster);

    expect(h.groups.update).toHaveBeenCalledWith(withOrders.id, {
      standingOrders: [withOrders.standingOrders[1]],
    });
  });

  it('closes a replacement once the node it named has left the fleet', async () => {
    const h = harness();
    h.engine.assess.mockResolvedValue(
      assessment({
        fulfilledExpansions: false,
        fulfilledReplacements: ['n-1'],
      }),
    );

    await h.service.reconcile(withOrders, cluster);

    expect(h.groups.update).toHaveBeenCalledWith(withOrders.id, {
      standingOrders: [withOrders.standingOrders[0]],
    });
  });

  it('is left alone while the fleet has not got there', async () => {
    const h = harness();
    h.engine.assess.mockResolvedValue(
      assessment({ fulfilledExpansions: false }),
    );

    await h.service.reconcile(withOrders, cluster);

    expect(h.groups.update).not.toHaveBeenCalled();
  });
});

describe('a purchase a person approves on a manual group', () => {
  const intent = {
    kind: 'add' as const,
    shape: 'cpx22',
    region: 'fsn1',
    hourlyEur: 0.0267,
    node: null,
    fleetMonthlyEur: 8.49,
    unpricedNodes: 0,
    fleetNodes: 1,
  };

  function approving(acted: unknown) {
    const manual = { ...group, provision: 'manual' } as ScalingGroupEntity;
    const decisions = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (row: unknown) => row),
    };
    const actuator = { act: jest.fn().mockResolvedValue(acted) };
    const service = new ScalingReconcilerService(
      { findOne: jest.fn().mockResolvedValue(manual) } as never,
      { findOne: jest.fn().mockResolvedValue(cluster) } as never,
      decisions as never,
      {
        assess: jest
          .fn()
          .mockResolvedValue(
            assessment({ intent, shape: 'cpx22', region: 'fsn1' }),
          ),
      } as never,
      actuator as never,
      { publish: jest.fn() } as never,
      { ring: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return { service, actuator, decisions };
  }

  it('buys once through the actuator, as if the group were automatic, and names who approved', async () => {
    const { service, actuator } = approving({
      outcome: 'added',
      did: 'Ordered a cpx22 in fsn1; it joins once provisioned.',
      why: 'This group buys automatically.',
      asks: null,
      operationId: 'op-1',
    });
    const row = await service.approvePurchase(
      'g-1',
      { shape: 'cpx22', region: 'fsn1' },
      'ada@example.com',
    );
    expect(actuator.act.mock.calls[0][0].provision).toBe('automatic');
    expect(row).toMatchObject({
      outcome: 'added',
      operationId: 'op-1',
      did: 'Ordered a cpx22 in fsn1; it joins once provisioned. Approved by ada@example.com.',
    });
    expect(row.why).toContain('the group stays manual');
  });

  it('buys nothing when the proposal changed since the page was read', async () => {
    const { service, actuator } = approving(null);
    await expect(
      service.approvePurchase('g-1', { shape: 'cx23', region: 'fsn1' }, 'ada'),
    ).rejects.toThrow('it is now a cpx22 in fsn1');
    expect(actuator.act).not.toHaveBeenCalled();
  });

  it("buys the ladder's choice even inside the settle window", async () => {
    const manual = { ...group, provision: 'manual' } as ScalingGroupEntity;
    const actuator = {
      act: jest.fn().mockResolvedValue({
        outcome: 'added',
        did: 'Ordered a cpx22 in fsn1.',
        why: 'x',
        asks: null,
        operationId: 'op-2',
      }),
    };
    const service = new ScalingReconcilerService(
      { findOne: jest.fn().mockResolvedValue(manual) } as never,
      { findOne: jest.fn().mockResolvedValue(cluster) } as never,
      {
        create: jest.fn((r: unknown) => r),
        save: jest.fn(async (r: unknown) => r),
      } as never,
      {
        assess: jest.fn().mockResolvedValue(
          assessment({
            did: 'Nothing yet.',
            intent: null,
            preview: {
              groupId: 'g-1',
              pending: { app: 'ns/probe', cpu: '50m', memory: '3072Mi' },
              opportunityHeldBecause: null,
              ladder: [],
              chosen: {
                step: 1,
                describes: 'x',
                shape: 'cpx22',
                region: 'fsn1',
                hourlyEur: 0.0267,
                outcome: 'would-buy',
              },
              asks: null,
            } as never,
          }),
        ),
      } as never,
      actuator as never,
      { publish: jest.fn() } as never,
      { ring: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const row = await service.approvePurchase(
      'g-1',
      { shape: 'cpx22', region: 'fsn1' },
      'ada',
    );
    expect(actuator.act.mock.calls[0][2].intent).toMatchObject({
      kind: 'add',
      shape: 'cpx22',
    });
    expect(row.operationId).toBe('op-2');
  });

  it('says why when a gate refused', async () => {
    const { service } = approving({
      outcome: 'declined',
      did: 'x',
      why: 'A machine is already on its way to this cluster.',
      asks: null,
      operationId: null,
    });
    await expect(
      service.approvePurchase('g-1', { shape: 'cpx22', region: 'fsn1' }, 'ada'),
    ).rejects.toThrow('already on its way');
  });
});
