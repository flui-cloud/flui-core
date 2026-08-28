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
  const service = new ScalingReconcilerService(
    {
      find: jest.fn().mockResolvedValue([group]),
    } as unknown as Repository<ScalingGroupEntity>,
    {
      find: jest.fn().mockResolvedValue([cluster]),
    } as unknown as Repository<ClusterEntity>,
    decisions as unknown as Repository<ScalingDecisionEntity>,
    engine as unknown as ScalingEngineService,
    actuator as unknown as ScalingActuatorService,
  );
  return { service, decisions, engine, actuator };
}

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
