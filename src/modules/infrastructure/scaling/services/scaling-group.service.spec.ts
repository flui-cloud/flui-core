import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { ScalingGroupService } from './scaling-group.service';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../entities/scaling-decision.entity';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { ProviderCapabilities } from '../../../management/entities/provider-capabilities.entity';
import {
  ScalingBoundsDto,
  WriteScalingGroupDto,
} from '../dto/scaling-group.dto';
import { SCALING_ERROR } from '../scaling-errors';

const capabilities = (
  over: Partial<ProviderCapabilities>,
): ProviderCapabilities =>
  ({
    supportedInstanceTypes: [],
    supportedRegions: [],
    credentialType: 'api_key',
    features: {
      loadBalancers: true,
      privateNetworking: true,
      snapshots: true,
      backups: true,
      dnsZones: true,
      nodeProvisioning: true,
    },
    pricing: { currency: 'EUR', billingCycle: 'hourly', minimumCost: 0.0056 },
    firewall: {
      backend: 'managed-api',
      managedEdge: true,
      supportsSshAllowlist: true,
    },
    vnetTopology: null,
    vnetRequired: true,
    crossClusterAllowed: false,
    ...over,
  }) as ProviderCapabilities;

const DECLARED: Record<string, ProviderCapabilities> = {
  hetzner: capabilities({}),
  contabo: capabilities({
    credentialType: 'user_password',
    features: {
      ...capabilities({}).features,
      nodeProvisioning: false,
    },
    pricing: { currency: 'EUR', billingCycle: 'monthly', minimumCost: 4.5 },
  }),
  byos: capabilities({
    credentialType: 'ssh',
    features: { ...capabilities({}).features, nodeProvisioning: false },
    pricing: { currency: 'EUR', billingCycle: 'monthly', minimumCost: 0 },
  }),
};

const cluster = (provider: string): ClusterEntity =>
  ({
    id: 'c-1',
    name: 'prod-eu',
    provider,
    nodeCount: 2,
  }) as ClusterEntity;

interface Fakes {
  service: ScalingGroupService;
  config: { get: jest.Mock };
  groups: { [K in keyof Repository<ScalingGroupEntity>]?: jest.Mock };
  decisions: { [K in keyof Repository<ScalingDecisionEntity>]?: jest.Mock };
  clusters: { findOne: jest.Mock };
  saved: () => ScalingGroupEntity;
}

const make = (provider = 'hetzner', existing: unknown[] = []): Fakes => {
  const groups = {
    find: jest.fn().mockResolvedValue(existing),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: ScalingGroupEntity) => ({ ...row })),
    save: jest.fn(async (row: ScalingGroupEntity) => ({ id: 'g-1', ...row })),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const decisions = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const clusters = {
    findOne: jest.fn().mockResolvedValue(cluster(provider)),
  };
  const factory = {
    isProviderSupported: (p: string) => p in DECLARED,
    getCapabilitiesService: (p: string) => ({
      getStaticCapabilities: () => DECLARED[p],
    }),
  } as unknown as CapabilitiesProviderFactory;
  // No grant: the default state of an installation nobody has told what it may
  // spend, and the one every assertion below should be read against.
  const config = { get: jest.fn().mockReturnValue(undefined) };

  return {
    service: new ScalingGroupService(
      groups as unknown as Repository<ScalingGroupEntity>,
      decisions as unknown as Repository<ScalingDecisionEntity>,
      clusters as unknown as Repository<ClusterEntity>,
      factory,
      config as unknown as ConfigService,
    ),
    groups,
    decisions,
    clusters,
    config,
    saved: () => groups.save.mock.calls[0][0] as ScalingGroupEntity,
  };
};

const write = (
  over: Partial<WriteScalingGroupDto> = {},
): WriteScalingGroupDto =>
  ({
    name: 'general',
    bounds: { min: 1, desired: 3, max: 5 },
    regions: ['fsn1'],
    shapes: ['cx23'],
    strategy: 'cheapest',
    settleSeconds: 30,
    limits: { hourlyBillingOnly: true, maxMonthlyCost: 40 },
    provision: 'automatic',
    ...over,
  }) as WriteScalingGroupDto;

describe('writing a scaling group', () => {
  it('stores the shapes in the order they were given', async () => {
    const { service, saved } = make();
    await service.create('c-1', write({ shapes: ['cx33', 'cx23', 'cpx31'] }));
    expect(saved().shapes).toEqual(['cx33', 'cx23', 'cpx31']);
  });

  it('keeps an absent ceiling absent, rather than turning it into zero', async () => {
    const { service, saved } = make();
    await service.create(
      'c-1',
      write({ limits: { hourlyBillingOnly: false } }),
    );
    expect(saved().maxMonthlyCost).toBeNull();
  });

  it('refuses a floor above the target', async () => {
    const { service } = make();
    await expect(
      service.create('c-1', write({ bounds: { min: 4, desired: 2, max: 5 } })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a target above the ceiling', async () => {
    const { service } = make();
    await expect(
      service.create('c-1', write({ bounds: { min: 1, desired: 6, max: 5 } })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 404 for a cluster that is not there', async () => {
    const { service, clusters } = make();
    clusters.findOne.mockResolvedValue(null);
    await expect(service.create('nope', write())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a second group with the same name on one cluster', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValue({ id: 'other', name: 'general' });
    await expect(service.create('c-1', write())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('what the provider declarations forbid a group to say', () => {
  it('refuses to buy for itself where there is no API to buy with', async () => {
    for (const provider of ['contabo', 'byos']) {
      const { service } = make(provider);
      await expect(
        service.create('c-1', write({ provision: 'automatic' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('lets Contabo hold shapes and regions, and only ask a person', async () => {
    const { service, saved } = make('contabo');
    await service.create(
      'c-1',
      write({
        provision: 'manual',
        regions: ['eu'],
        shapes: ['vps-10', 'vps-20'],
      }),
    );
    expect(saved().shapes).toEqual(['vps-10', 'vps-20']);
    expect(saved().requirement).toBeNull();
  });

  it('refuses a shape where no catalogue publishes one', async () => {
    const { service } = make('byos');
    await expect(
      service.create(
        'c-1',
        write({ provision: 'manual', shapes: ['dell-r640'], regions: [] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('asks BYOS what a machine has to hold instead', async () => {
    const { service } = make('byos');
    await expect(
      service.create(
        'c-1',
        write({ provision: 'manual', shapes: [], regions: [] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const { service: second, saved } = make('byos');
    await second.create(
      'c-1',
      write({
        provision: 'manual',
        shapes: [],
        regions: [],
        requirement: { cpu: '2', memory: '8Gi' },
      }),
    );
    expect(saved().requirement).toEqual({ cpu: '2', memory: '8Gi' });
  });

  it('refuses a requirement where the shapes already carry it, with a price', async () => {
    const { service } = make('hetzner');
    await expect(
      service.create(
        'c-1',
        write({ requirement: { cpu: '2', memory: '8Gi' } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('standing orders', () => {
  const order = write({
    standingOrders: [
      {
        kind: 'expand',
        shape: 'cx23',
        region: 'fsn1',
        wanted: 2,
        replaces: null,
      },
    ],
  });

  it('takes an expansion, which drains nothing', async () => {
    const { service, saved } = make();
    await service.create('c-1', order);
    expect(saved().standingOrders).toEqual([
      {
        kind: 'expand',
        shape: 'cx23',
        region: 'fsn1',
        wanted: 2,
        replaces: null,
      },
    ]);
  });

  it('refuses an expansion that names a node to replace', async () => {
    const { service } = make();
    await expect(
      service.create(
        'c-1',
        write({
          standingOrders: [
            {
              kind: 'expand',
              shape: 'cx23',
              region: 'fsn1',
              wanted: 1,
              replaces: 'prod-eu-worker-3',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a replacement that names none', async () => {
    const { service } = make();
    await expect(
      service.create(
        'c-1',
        write({
          standingOrders: [
            {
              kind: 'replace',
              shape: 'cx23',
              region: 'fsn1',
              wanted: 1,
              replaces: null,
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to wait for a shape the group may not buy', async () => {
    const { service } = make();
    await expect(
      service.create(
        'c-1',
        write({
          shapes: ['cx23'],
          standingOrders: [
            {
              kind: 'expand',
              shape: 'cx43',
              region: 'fsn1',
              wanted: 1,
              replaces: null,
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to wait in a region the group may not buy in', async () => {
    const { service } = make();
    await expect(
      service.create(
        'c-1',
        write({
          regions: ['fsn1'],
          standingOrders: [
            {
              kind: 'expand',
              shape: 'cx23',
              region: 'hel1',
              wanted: 1,
              replaces: null,
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('reading a group back', () => {
  const stored = (over: Partial<ScalingGroupEntity> = {}) =>
    ({
      id: 'g-1',
      clusterId: 'c-1',
      name: 'general',
      minNodes: 1,
      desiredNodes: 3,
      maxNodes: 5,
      regions: ['fsn1'],
      shapes: ['cx23', 'cx33'],
      strategy: 'cheapest',
      settleSeconds: 30,
      hourlyBillingOnly: true,
      maxMonthlyCost: null,
      provision: 'automatic',
      standingOrders: [
        {
          kind: 'expand',
          shape: 'cx23',
          region: 'fsn1',
          wanted: 2,
          replaces: null,
        },
      ],
      requirement: null,
      ...over,
    }) as ScalingGroupEntity;

  it('carries the capability and the cluster beside the group', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValue(stored());
    const dto = await service.get('g-1');
    expect(dto.clusterName).toBe('prod-eu');
    expect(dto.capability).toEqual({
      provider: 'hetzner',
      canProvision: true,
      hasCatalogue: true,
      billing: 'hourly',
    });
  });

  /**
   * Both are read at the moment of acting, from a catalogue and from a node.
   * A stored copy would be a stale one, and a stale outlook is exactly what the
   * whole integration must never present as a live reading.
   */
  it('leaves the market and the drain unanswered rather than guessing', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValue(stored());
    const [order] = (await service.get('g-1')).standingOrders;
    expect(order.outlook).toBeNull();
    expect(order.drainable).toBeNull();
  });

  it('says a group will not act while the installation has granted nothing', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValue(stored());
    const dto = await service.get('g-1');
    expect(dto.acts.acts).toBe(false);
    expect(dto.acts.says).toContain('SCALING_CONCESSION_MONTHLY_EUR');
    // Never 0: a grant of nothing and no grant at all are different instructions.
    expect(dto.acts.monthlyEur).toBeNull();
  });

  it('needs the group to be set to act as well as the grant', async () => {
    const { service, groups, config } = make();
    config.get.mockReturnValue('40');
    groups.findOne?.mockResolvedValue(stored({ provision: 'manual' }));
    const dto = await service.get('g-1');
    expect(dto.acts.acts).toBe(false);
    expect(dto.acts.says).toContain('decides and does not act');
  });

  it('acts only when both keys turn', async () => {
    const { service, groups, config } = make();
    config.get.mockReturnValue('40');
    groups.findOne?.mockResolvedValue(stored());
    const dto = await service.get('g-1');
    expect(dto.acts).toMatchObject({ acts: true, monthlyEur: 40 });
  });

  it('never claims a group acts where nothing can create a server', async () => {
    const { service, groups, config } = make('byos');
    config.get.mockReturnValue('40');
    groups.findOne?.mockResolvedValue(stored());
    const dto = await service.get('g-1');
    expect(dto.acts.acts).toBe(false);
    expect(dto.acts.says).toContain('cannot create a server');
    // And it does not quote the installation's grant beside that sentence: the
    // grant governs purchases, and this group will never make one.
    expect(dto.acts.monthlyEur).toBeNull();
  });

  it('carries the drain the last pass found onto the order it belongs to', async () => {
    const { service, groups, decisions } = make();
    groups.findOne?.mockResolvedValue(
      stored({
        standingOrders: [
          {
            kind: 'replace',
            shape: 'cx23',
            region: 'fsn1',
            wanted: 1,
            replaces: 'prod-eu-worker-2',
          },
        ],
      }),
    );
    decisions.findOne?.mockResolvedValue({
      drain: { ok: false, blockers: [], cleared: [] },
    });
    const [order] = (await service.get('g-1')).standingOrders;
    expect(order.drainable).toEqual({ ok: false, blockers: [], cleared: [] });
  });

  it('takes the decisions with the group when it is removed', async () => {
    const { service, groups, decisions } = make();
    groups.findOne?.mockResolvedValue(stored());
    await service.remove('g-1');
    expect(decisions.delete).toHaveBeenCalledWith({ groupId: 'g-1' });
    expect(groups.delete).toHaveBeenCalledWith({ id: 'g-1' });
  });

  it('answers 404 for a group that is not there', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValue(null);
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('holds the decision window inside its bounds', async () => {
    const { service, groups, decisions } = make();
    groups.findOne?.mockResolvedValue(stored());
    await service.decisionsOf('g-1', 5000);
    expect(decisions.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });
});

/**
 * A cluster that should hold no nodes at all is a thing a group has to be able
 * to say — and where nothing can be provisioned the ceiling never gated
 * anything anyway, it reports.
 */
describe('a ceiling of zero', () => {
  it('is a bound the validator accepts', async () => {
    const bounds = plainToInstance(ScalingBoundsDto, {
      min: 0,
      desired: 0,
      max: 0,
    });
    expect(await validate(bounds)).toEqual([]);
  });

  it('is refused a floor or a target above it, like any other ceiling', async () => {
    const { service } = make('byos');
    await expect(
      service.create(
        'c-1',
        write({
          provision: 'manual',
          shapes: [],
          regions: [],
          requirement: { cpu: '2', memory: '8Gi' },
          bounds: { min: 1, desired: 1, max: 0 },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is stored as written when the three agree', async () => {
    const { service, saved } = make('byos');
    await service.create(
      'c-1',
      write({
        provision: 'manual',
        shapes: [],
        regions: [],
        requirement: { cpu: '2', memory: '8Gi' },
        bounds: { min: 0, desired: 0, max: 0 },
      }),
    );
    expect(saved().maxNodes).toBe(0);
  });
});

/** The one question a person asks, asked of the cluster they asked it about. */
describe('the decisions of a cluster', () => {
  const decision = (over: Partial<ScalingDecisionEntity> = {}) =>
    ({
      id: 'd-1',
      groupId: 'g-1',
      clusterId: 'c-1',
      at: new Date('2026-08-26T07:12:00Z'),
      force: 'urgency',
      outcome: 'declined',
      saw: '1 pod pending',
      did: 'Nothing.',
      why: 'Not stuck long enough yet.',
      asks: null,
      shape: null,
      region: null,
      hourlyPriceEur: null,
      considered: [],
      ...over,
    }) as ScalingDecisionEntity;

  it('answers without being told which group to ask', async () => {
    const { service, groups, decisions } = make();
    groups.find?.mockResolvedValue([
      { id: 'g-1', name: 'general' },
      { id: 'g-2', name: 'heavy' },
    ]);
    decisions.find?.mockResolvedValue([
      decision({ groupId: 'g-2' }),
      decision({ groupId: 'g-1' }),
    ]);

    const rows = await service.decisionsOfCluster('c-1');

    expect(rows.map((r) => r.groupName)).toEqual(['heavy', 'general']);
    expect(decisions.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clusterId: 'c-1' } }),
    );
  });

  it('holds the window inside the same bounds as one group’s', async () => {
    const { service, decisions } = make();
    await service.decisionsOfCluster('c-1', 5000);
    expect(decisions.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it('answers a missing cluster with the code that says so', async () => {
    const { service, clusters } = make();
    clusters.findOne.mockResolvedValue(null);
    await expect(service.decisionsOfCluster('nope')).rejects.toMatchObject({
      response: { code: SCALING_ERROR.CLUSTER_NOT_FOUND },
    });
  });
});

/**
 * 404 is three answers on this surface, and the prose was the only thing telling
 * them apart — so a caller had to read a message to branch on it.
 */
describe('a refusal a caller can branch on', () => {
  it('names the group as the thing that is missing', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValue(null);
    await expect(service.get('nope')).rejects.toMatchObject({
      response: { code: SCALING_ERROR.GROUP_NOT_FOUND },
    });
  });

  it('names the clash on a second group of the same name', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValue({ id: 'other', name: 'general' });
    await expect(service.create('c-1', write())).rejects.toMatchObject({
      response: { code: SCALING_ERROR.GROUP_NAME_TAKEN },
    });
  });
});

describe('changing a group', () => {
  const stored = {
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
  } as unknown as ScalingGroupEntity;

  it('removes the ceiling when the limits arrive without one', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValueOnce({ ...stored });
    groups.findOne?.mockResolvedValueOnce(null);
    const dto = await service.update('g-1', {
      limits: { hourlyBillingOnly: true },
    });
    expect(dto.limits.maxMonthlyCost).toBeNull();
  });

  it('refuses bounds that would leave the floor above the ceiling', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValueOnce({ ...stored });
    await expect(
      service.update('g-1', { bounds: { min: 9, desired: 9, max: 5 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * Present, not truthy. An empty list is a value somebody sent, and a PATCH
   * that reported success while discarding it is worse than one that refuses.
   */
  it('empties the regions when an empty list is what arrived', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValueOnce({ ...stored });
    groups.findOne?.mockResolvedValueOnce(null);
    const dto = await service.update('g-1', { regions: [] });
    expect(dto.regions).toEqual([]);
  });

  it('empties the shapes, and the standing orders, on the same terms', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValueOnce({
      ...stored,
      standingOrders: [
        {
          kind: 'expand',
          shape: 'cx23',
          region: 'fsn1',
          wanted: 1,
          replaces: null,
        },
      ],
    });
    groups.findOne?.mockResolvedValueOnce(null);

    const dto = await service.update('g-1', { shapes: [], standingOrders: [] });

    expect(dto.shapes).toEqual([]);
    expect(dto.standingOrders).toEqual([]);
  });

  /**
   * Clearing the shapes under an order that waits for one leaves a wait that can
   * never end, so the same check that guards a write guards the emptying.
   */
  it('refuses to empty the shapes a standing order still waits for', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValueOnce({
      ...stored,
      standingOrders: [
        {
          kind: 'expand',
          shape: 'cx23',
          region: 'fsn1',
          wanted: 1,
          replaces: null,
        },
      ],
    });
    await expect(service.update('g-1', { shapes: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('leaves untouched what the body did not mention', async () => {
    const { service, groups } = make();
    groups.findOne?.mockResolvedValueOnce({ ...stored });
    groups.findOne?.mockResolvedValueOnce(null);
    const dto = await service.update('g-1', { regions: [] });
    expect(dto.shapes).toEqual(['cx23']);
    expect(dto.limits.maxMonthlyCost).toBe(40);
  });
});
