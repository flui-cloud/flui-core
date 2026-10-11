/**
 * The Scaling section, on the example organisation's cluster.
 *
 * One group on `northwind-prod`, buying on its own within a spending ceiling,
 * that has done exactly one thing worth telling this week: it bought a worker
 * on a busy afternoon and gave it back after a quiet night. Everything since
 * is "nothing to do", which is what a healthy group says most of the time.
 *
 * The bounds count every node, the master included, because that is what the
 * real group counts: two to four workers are bounds of three to five.
 *
 * The labels, the sentence that says what the group may do and the cost
 * scenarios are produced by the same functions the real group uses, from the
 * example group's own facts — so the wording a guest reads here is the wording
 * they would read on their own instance.
 */
import { scalingModeLabel } from '../../infrastructure/scaling/scaling-consequence';
import { scalingCost } from '../../infrastructure/scaling/cost-scenarios.core';
import { ShapeFactsReading } from '../../infrastructure/scaling/engine/engine.core';
import {
  CLUSTER_ID,
  CLUSTER_NAME,
  hoursAgo,
  mark,
  PROVIDER,
  REGION,
  SandboxStandInQuery,
} from './sandbox-world-core';
import {
  activeMonthlyCents,
  fleetLifetimes,
  SERVER_PRICES,
} from './sandbox-world-fleet';

type Params = Record<string, string | undefined>;

export const SCALING_GROUP_ID = 'example-scaling-group-1';
export const SCALING_GROUP_NAME = 'northwind-workers';

export const BOUNDS = { min: 3, desired: 3, max: 5 };
const SHAPES = [SERVER_PRICES.CPX41, SERVER_PRICES.CPX31];
export const CEILING_EUR = 130;
const CAPABILITY = {
  provider: PROVIDER,
  canProvision: true,
  hasCatalogue: true,
  billing: 'hourly' as const,
};

const SPECS: Record<string, { cores: number; memoryMi: number }> = {
  cpx31: { cores: 4, memoryMi: 8192 },
  cpx41: { cores: 8, memoryMi: 16_384 },
};

const CATALOGUE_AGE_SECONDS = 420;

/**
 * The rest of the provider's shelf, listed in the Market beside the two the
 * group buys: smaller and larger shapes, Arm and dedicated cores, one running
 * short and one sold out, as a real catalogue reads on an ordinary day.
 */
const MARKET_EXTRAS = [
  {
    shape: 'cx22',
    cores: 2,
    memoryMi: 4096,
    hourlyEur: 0.006,
    monthlyEur: 3.79,
    state: 'available',
    upIn: [REGION, 'nbg1', 'hel1'],
    downIn: [],
  },
  {
    shape: 'cx32',
    cores: 4,
    memoryMi: 8192,
    hourlyEur: 0.0109,
    monthlyEur: 6.8,
    state: 'available',
    upIn: [REGION, 'nbg1', 'hel1'],
    downIn: [],
  },
  {
    shape: 'cx42',
    cores: 8,
    memoryMi: 16_384,
    hourlyEur: 0.0263,
    monthlyEur: 16.4,
    state: 'available',
    upIn: [REGION, 'nbg1'],
    downIn: [],
  },
  {
    shape: 'cpx21',
    cores: 3,
    memoryMi: 4096,
    hourlyEur: 0.0121,
    monthlyEur: 7.55,
    state: 'available',
    upIn: [REGION, 'nbg1', 'hel1'],
    downIn: [],
  },
  {
    shape: 'cpx51',
    cores: 16,
    memoryMi: 32_768,
    hourlyEur: 0.088,
    monthlyEur: 54.9,
    state: 'limited',
    upIn: ['nbg1'],
    downIn: [REGION],
  },
  {
    shape: 'cax21',
    cores: 4,
    memoryMi: 8192,
    hourlyEur: 0.0104,
    monthlyEur: 6.49,
    state: 'available',
    upIn: [REGION, 'nbg1', 'hel1'],
    downIn: [],
  },
  {
    shape: 'ccx23',
    cores: 4,
    memoryMi: 16_384,
    hourlyEur: 0.0389,
    monthlyEur: 24.49,
    state: 'sold-out',
    upIn: [],
    downIn: [REGION, 'nbg1'],
  },
] as const;

interface MarketShape {
  shape: string;
  allowed: boolean;
  outlook: {
    state: string;
    upIn: string[];
    downIn: string[];
    sinceHours: number | null;
    ageSeconds: number;
  };
  why: string;
  facts: {
    cores: number;
    memoryMi: number;
    hourlyEur: number;
    monthlyEur: number;
  };
}

/** The engine looks every few minutes; this is when it last found nothing to do. */
export const LAST_LOOK_HOURS = 4 / 60;

const shapeFacts = (): ShapeFactsReading => ({
  read: true,
  ageSeconds: CATALOGUE_AGE_SECONDS,
  shapes: SHAPES.map((s) => ({
    shape: s.serverType,
    ...SPECS[s.serverType],
    deprecated: false,
    supportsHourlyBilling: true,
    architecture: 'x86' as const,
    prices: [
      { region: REGION, hourlyEur: s.hourlyNet, monthlyEur: s.monthlyNet },
    ],
    availability: [{ region: REGION, up: true }],
  })),
});

const modeOf = () =>
  scalingModeLabel({
    provider: PROVIDER,
    canProvision: CAPABILITY.canProvision,
    provision: 'automatic',
    maxMonthlyCost: CEILING_EUR,
    maxNodes: BOUNDS.max,
  });

const activeNodes = (now: number) =>
  fleetLifetimes(now).filter((l) => l.endedAt === null).length;

/**
 * The row of the example cluster. Asked for by the Scaling section with the
 * example cluster's id, and by the Scaling tab of the guest's own cluster with
 * the guest's: the answer carries the id it was asked for either way, so the
 * tab and the section describe the same group.
 */
export function exampleScalingRow(
  now: number,
  _query?: SandboxStandInQuery,
  params?: Params,
) {
  const monthly = activeMonthlyCents(now).compute / 100;
  return mark({
    clusterId: params?.clusterId ?? CLUSTER_ID,
    clusterName: CLUSTER_NAME,
    capability: { ...CAPABILITY },
    groupId: SCALING_GROUP_ID,
    groupCount: 1,
    groups: [
      mark({
        id: SCALING_GROUP_ID,
        name: SCALING_GROUP_NAME,
        provision: 'automatic',
        bounds: { ...BOUNDS },
      }),
    ],
    bounds: { ...BOUNDS },
    nodes: activeNodes(now),
    monthlyEur: monthly,
    unpricedNodes: 0,
    monthlyCap: CEILING_EUR,
    pendingPods: 0,
    acts: true,
    mode: modeOf(),
    openOrders: 0,
    blockedOrders: 0,
    openAlarm: null,
    lastDecisionAt: hoursAgo(now, LAST_LOOK_HOURS),
    needsPerson: null,
  });
}

export function exampleScalingRows(now: number) {
  return [exampleScalingRow(now)];
}

/** The example group answers to its own id only; a missing id asks the example world as a whole. */
export const isExampleGroup = (params?: Params): boolean =>
  !params?.id || params.id === SCALING_GROUP_ID;

export function exampleScalingGroup(
  _now?: number,
  _query?: SandboxStandInQuery,
  params?: Params,
) {
  if (!isExampleGroup(params)) return null;
  const mode = modeOf();
  return mark({
    id: SCALING_GROUP_ID,
    name: SCALING_GROUP_NAME,
    clusterId: CLUSTER_ID,
    clusterName: CLUSTER_NAME,
    provider: PROVIDER,
    capability: { ...CAPABILITY },
    buyableRegions: [REGION],
    bounds: { ...BOUNDS },
    regions: [REGION],
    shapes: SHAPES.map((s) => s.serverType),
    strategy: 'cheapest',
    settleSeconds: 120,
    limits: { hourlyBillingOnly: true, maxMonthlyCost: CEILING_EUR },
    provision: 'automatic',
    standingOrders: [],
    acts: {
      ...mode,
      acts: true,
      says: `This group buys through the provider API on its own, up to ${BOUNDS.max} nodes. Under that, the engine never lets the fleet's monthly list price pass the spending ceiling of €${CEILING_EUR} a month.`,
    },
    requirement: { cpu: '2', memory: '4Gi' },
    purchaseHeld: null,
    purchase: null,
    cost: scalingCost({
      provider: PROVIDER,
      hasCatalogue: CAPABILITY.hasCatalogue,
      min: BOUNDS.min,
      max: BOUNDS.max,
      shapes: SHAPES.map((s) => s.serverType),
      regions: [REGION],
      maxMonthlyCost: CEILING_EUR,
      facts: shapeFacts(),
    }),
  });
}

/** Where the example nodes stand: room on every worker, nothing waiting. */
const ROOM = [
  {
    name: 'flui-edge-1',
    role: 'master',
    cpu: [3800, 1450, 900],
    mem: [7600, 3100, 2600],
    apps: [],
  },
  {
    name: 'flui-worker-1',
    role: 'worker',
    cpu: [7800, 3200, 1700],
    mem: [15_800, 7400, 6100],
    apps: ['storefront', 'orders-api'],
  },
  {
    name: 'flui-worker-2',
    role: 'worker',
    cpu: [7800, 2900, 1400],
    mem: [15_800, 6800, 5900],
    apps: ['orders-db', 'internal-tools'],
  },
] as const;

export function exampleScalingPreview(
  _now?: number,
  _query?: SandboxStandInQuery,
  params?: Params,
) {
  if (!isExampleGroup(params)) return null;
  const nodes = ROOM.map((n) => ({
    name: n.name,
    role: n.role,
    takesWork: n.role === 'worker',
    allocatable: { cpuMillicores: n.cpu[0], memoryMi: n.mem[0] },
    requested: { cpuMillicores: n.cpu[1], memoryMi: n.mem[1] },
    limits: { cpuMillicores: n.cpu[1] * 2, memoryMi: n.mem[1] },
    used: { cpuMillicores: n.cpu[2], memoryMi: n.mem[2] },
    apps: [...n.apps],
    free: {
      cpuMillicores: n.cpu[0] - n.cpu[1],
      memoryMi: n.mem[0] - n.mem[1],
    },
  }));
  const roomiest = nodes
    .filter((n) => n.takesWork)
    .reduce((a, b) => (b.free.memoryMi > a.free.memoryMi ? b : a), nodes[1]);
  const [first] = SHAPES;
  const rung = {
    step: 1,
    describes: 'The first machine on the list, in the cluster’s own region',
    shape: first.serverType,
    region: REGION,
    hourlyEur: first.hourlyNet,
    outcome: 'would-buy' as const,
  };
  return mark({
    groupId: SCALING_GROUP_ID,
    pending: null,
    opportunityHeldBecause: null,
    ladder: [rung],
    chosen: rung,
    asks: null,
    blocked: null,
    giveBack: null,
    room: {
      nodes,
      largestFit: { node: roomiest.name, ...roomiest.free },
    },
  });
}

export function exampleScalingCatalogue(
  _now?: number,
  _query?: SandboxStandInQuery,
  params?: Params,
) {
  if (!isExampleGroup(params)) return null;
  return mark({
    groupId: SCALING_GROUP_ID,
    provider: PROVIDER,
    reading: 'read',
    ageSeconds: CATALOGUE_AGE_SECONDS,
    stale: false,
    says: 'Hetzner Cloud publishes its machines, their prices and where each can be bought.',
    shapes: SHAPES.map(
      (s): MarketShape => ({
        shape: s.serverType,
        allowed: true,
        outlook: {
          state: 'available',
          upIn: [REGION],
          downIn: [],
          sinceHours: null,
          ageSeconds: CATALOGUE_AGE_SECONDS,
        },
        why: 'On this group’s list, and for sale where it may buy.',
        facts: {
          ...SPECS[s.serverType],
          hourlyEur: s.hourlyNet,
          monthlyEur: s.monthlyNet,
        },
      }),
    ).concat(
      MARKET_EXTRAS.map(
        (x): MarketShape => ({
          shape: x.shape,
          allowed: false,
          outlook: {
            state: x.state,
            upIn: [...x.upIn],
            downIn: [...x.downIn],
            sinceHours: x.state === 'available' ? null : 6,
            ageSeconds: CATALOGUE_AGE_SECONDS,
          },
          why: 'Not on this group’s list.',
          facts: {
            cores: x.cores,
            memoryMi: x.memoryMi,
            hourlyEur: x.hourlyEur,
            monthlyEur: x.monthlyEur,
          },
        }),
      ),
    ),
  });
}
