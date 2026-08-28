// The service that buys reaches the VNet maths and an ESM-only CIDR package,
// and the engine's assessment type reaches the pending-pod reader. Nothing here
// calls through either.
jest.mock('ip-cidr', () => ({}));
jest.mock('@kubernetes/client-node', () => ({}));

import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../../servers/entities/infrastructure-operations.entity';
import { ClusterScalingService } from '../../clusters/services/cluster-scaling.service';
import { AutoscaleReconcilerRegistry } from '../../clusters/services/autoscale-reconciler.registry';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ProviderScalingCapability } from '../scaling-capability';
import { ScalingGroupService } from '../services/scaling-group.service';
import { ScalingIntent } from '../scaling.core';
import { ScalingActuatorService } from './scaling-actuator.service';
import { ScalingAssessment } from './scaling-engine.service';

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

const cluster = {
  id: 'c-1',
  provider: 'hetzner',
  region: 'fsn1',
  nodeSize: 'cx32',
  status: ClusterStatus.READY,
} as ClusterEntity;

const group = (over: Partial<ScalingGroupEntity> = {}): ScalingGroupEntity =>
  ({
    id: 'g-1',
    clusterId: 'c-1',
    provision: 'automatic',
    ...over,
  }) as ScalingGroupEntity;

const intent = (over: Partial<ScalingIntent> = {}): ScalingIntent => ({
  kind: 'add',
  shape: 'cx32',
  region: 'fsn1',
  hourlyEur: 0.0074,
  node: null,
  fleetMonthlyEur: 5.4,
  unpricedNodes: 0,
  fleetNodes: 1,
  ...over,
});

const assessment = (over: Partial<ScalingAssessment> = {}): ScalingAssessment =>
  ({
    groupId: 'g-1',
    clusterId: 'c-1',
    force: 'urgency',
    outcome: 'declined',
    saw: '1 pod the scheduler could not place.',
    did: 'Would add a cx32 in fsn1.',
    why: 'Nothing acts on a scaling decision here.',
    asks: null,
    shape: 'cx32',
    region: 'fsn1',
    hourlyEur: 0.0074,
    considered: [],
    intent: intent(),
    drain: null,
    ...over,
  }) as ScalingAssessment;

function harness(
  capability: ProviderScalingCapability = HETZNER,
  inFlight = 0,
) {
  const operations = { count: jest.fn().mockResolvedValue(inFlight) };
  const groups = { count: jest.fn().mockResolvedValue(1) };
  const clusterRows = { findOne: jest.fn().mockResolvedValue(cluster) };
  const clusters = {
    addWorkers: jest.fn().mockResolvedValue({ id: 'op-1' }),
    removeWorker: jest.fn().mockResolvedValue({ id: 'op-2' }),
  };
  const groupService = { capabilityOf: jest.fn().mockReturnValue(capability) };
  const registry = new AutoscaleReconcilerRegistry();

  const service = new ScalingActuatorService(
    operations as unknown as Repository<InfrastructureOperationEntity>,
    groups as unknown as Repository<ScalingGroupEntity>,
    clusterRows as unknown as Repository<ClusterEntity>,
    clusters as unknown as ClusterScalingService,
    groupService as unknown as ScalingGroupService,
    registry,
  );
  return { service, clusters, operations, groups, registry };
}

describe('the only thing with hands', () => {
  it('buys the shape the ladder chose, not the size the cluster happens to be', async () => {
    const h = harness();

    const acted = await h.service.act(group(), cluster, assessment());

    expect(h.clusters.addWorkers).toHaveBeenCalledWith('c-1', 1, 'cx32');
    expect(acted).toMatchObject({ outcome: 'added', operationId: 'op-1' });
  });

  it('clears what a person had to do once it has done it', async () => {
    const h = harness();
    const acted = await h.service.act(group(), cluster, assessment());
    expect(acted?.asks).toBeNull();
  });

  it('buys nothing for a group that only decides', async () => {
    const h = harness();

    const acted = await h.service.act(
      group({ provision: 'manual' }),
      cluster,
      assessment(),
    );

    expect(h.clusters.addWorkers).not.toHaveBeenCalled();
    expect(acted?.why).toContain('decide and not to act');
  });

  it('leaves an alert-only provider exactly as the engine wrote it', async () => {
    const h = harness(BYOS);

    const acted = await h.service.act(group(), cluster, assessment());

    expect(acted).toBeNull();
    expect(h.clusters.addWorkers).not.toHaveBeenCalled();
  });

  it('does nothing at all when the decision would do nothing', async () => {
    const h = harness();

    const acted = await h.service.act(
      group(),
      cluster,
      assessment({ intent: null }),
    );

    expect(acted).toBeNull();
  });

  it('waits for the machine already on its way instead of buying another', async () => {
    const h = harness(HETZNER, 1);

    const acted = await h.service.act(group(), cluster, assessment());

    expect(h.clusters.addWorkers).not.toHaveBeenCalled();
    expect(acted?.why).toContain('already on its way');
  });

  it('removes the node a decision named', async () => {
    const h = harness();

    const acted = await h.service.act(
      group(),
      cluster,
      assessment({
        did: 'Would remove prod-eu-worker-3, which can be emptied.',
        intent: intent({ kind: 'remove', node: 'n-3' }),
      }),
    );

    expect(h.clusters.removeWorker).toHaveBeenCalledWith('c-1', 'n-3');
    expect(acted).toMatchObject({ outcome: 'removed' });
    expect(acted?.did).toContain('Removed prod-eu-worker-3');
  });

  it('calls a removal that finishes a standing order a replacement, not a trim', async () => {
    const h = harness();

    const acted = await h.service.act(
      group(),
      cluster,
      assessment({
        did: 'Would remove prod-eu-worker-3, which can be emptied.',
        intent: intent({
          kind: 'remove',
          node: 'n-3',
          completesReplacement: true,
        }),
      }),
    );

    expect(acted).toMatchObject({ outcome: 'replaced' });
  });

  it('says the fleet is about to change, not that nothing is bought, when a removal waits', async () => {
    const h = harness(HETZNER, 1);

    const acted = await h.service.act(
      group(),
      cluster,
      assessment({ intent: intent({ kind: 'remove', node: 'n-3' }) }),
    );

    expect(h.clusters.removeWorker).not.toHaveBeenCalled();
    expect(acted?.why).toContain('about to be a different size');
    expect(acted?.why).not.toContain('is bought');
  });

  it('turns a refusal from the provider into an alarm rather than swallowing it', async () => {
    const h = harness();
    h.clusters.addWorkers.mockRejectedValue(
      new Error('Cluster has no VNet attached.'),
    );

    const acted = await h.service.act(group(), cluster, assessment());

    expect(acted).toMatchObject({ outcome: 'alerted' });
    expect(acted?.why).toContain('no VNet');
    // An alarm nobody can see is not an alarm: the overview lists the ones that
    // ask something of a person, and a failed purchase asks the most.
    expect(acted?.asks).toContain('no VNet');
  });
});

describe('what a cluster says about itself', () => {
  it('promises a node only where a grant, a group and a provider all agree', async () => {
    const h = harness();
    expect(await h.service.drivesCluster('c-1')).toBe(true);
  });

  it('promises nothing where every group only decides', async () => {
    const h = harness();
    h.groups.count.mockResolvedValue(0);
    expect(await h.service.drivesCluster('c-1')).toBe(false);
  });

  it('promises nothing on a provider Flui cannot buy from', async () => {
    const h = harness(BYOS);
    expect(await h.service.drivesCluster('c-1')).toBe(false);
  });

  it('registers itself as what drives a cluster, so the promise cannot outlive it', async () => {
    const h = harness();
    h.service.onModuleInit();

    expect(h.registry.driven).toBe(true);
    expect(await h.registry.drivesCluster('c-1')).toBe(true);
  });
});
