/**
 * The Pricing tab of a cluster: the example organisation's month so far.
 *
 * The real answer is the operator's invoice. This one is the example machines, the
 * worker the scaling group added and gave back, and the shared volume — priced
 * by the same rules the real bill follows, so the numbers add up the way a
 * person checking them expects.
 */
import { billingOf } from '../../infrastructure/clusters/costs/provider-billing';
import { clusterOf } from './sandbox-world-cluster';
import {
  CLUSTER_NAME,
  mark,
  PROVIDER,
  REGION,
  SandboxStandInQuery,
} from './sandbox-world-core';
import {
  activeMonthlyCents,
  billingMonth,
  CURRENCY,
  fixed2,
  fixed4,
  fleetLifetimes,
  hoursThisMonth,
  MACHINES_SINCE_DAYS,
  nodeCost4,
  SERVER_PRICES,
  SHARED_VOLUME,
  VAT_PERCENT,
  volumeCost4,
  withVat,
} from './sandbox-world-fleet';

type Params = Record<string, string | undefined>;

const breakdown4 = (compute: number, storage: number) => ({
  computeGross: fixed4(withVat(compute)),
  computeNet: fixed4(compute),
  storageGross: fixed4(withVat(storage)),
  storageNet: fixed4(storage),
  trafficGross: fixed4(0),
  trafficNet: fixed4(0),
});

const breakdown2 = (compute: number, storage: number) => ({
  computeGross: fixed2(withVat(compute)),
  computeNet: fixed2(compute),
  storageGross: fixed2(withVat(storage)),
  storageNet: fixed2(storage),
  trafficGross: fixed2(0),
  trafficNet: fixed2(0),
});

/** Hetzner includes this much outgoing traffic per machine and month. */
const INCLUDED_TRAFFIC_PER_MACHINE = 20 * 1024 ** 4;

/**
 * The month so far for the example fleet, priced the way the real bill is:
 * by the started hour, never more than a machine's monthly price, VAT added at
 * the rate of the account. The worker the scaling group gave back is in it for
 * the hours it ran, if those hours fell in this month.
 */
export function exampleClusterBilling(
  now: number,
  _query?: SandboxStandInQuery,
  params?: Params,
) {
  const month = billingMonth(now);
  const lives = fleetLifetimes(now);

  const nodes = lives
    .map((life) => {
      const hours = hoursThisMonth(life, month, now);
      const cost = nodeCost4(life.shape, hours);
      const projected =
        life.endedAt === null
          ? Math.round(
              nodeCost4(life.shape, hours + month.remainingHours) / 100,
            )
          : Math.round(cost / 100);
      const serverType = SERVER_PRICES[life.shape].serverType;
      const segmentStart = new Date(Math.max(life.startedAt, month.start));
      return {
        life,
        hours,
        cost,
        projected,
        row: mark({
          nodeId: life.id,
          serverName: life.name,
          nodeType: life.role,
          currentServerType: serverType,
          providerResourceId: `example-${life.id.split('-').pop()}`,
          status: life.endedAt === null ? 'active' : 'terminated',
          billableHours: hours,
          costGross: fixed4(withVat(cost)),
          costNet: fixed4(cost),
          segments: [
            {
              serverType,
              startedAt: segmentStart.toISOString(),
              endedAt:
                life.endedAt === null
                  ? null
                  : new Date(life.endedAt).toISOString(),
              hours,
              costGross: fixed4(withVat(cost)),
              costNet: fixed4(cost),
            },
          ],
        }),
      };
    })
    .filter((n) => n.hours > 0);

  const volumeHours = hoursThisMonth(
    { startedAt: now - MACHINES_SINCE_DAYS * 86_400_000, endedAt: null },
    month,
    now,
  );
  const volumeCost = volumeCost4(volumeHours, month);
  const volumeProjected = Math.round(
    volumeCost4(volumeHours + month.remainingHours, month) / 100,
  );

  const compute = nodes.reduce((sum, n) => sum + n.cost, 0);
  const computeGross = nodes.reduce((sum, n) => sum + withVat(n.cost), 0);
  const forecastCompute = nodes.reduce((sum, n) => sum + n.projected, 0);
  const forecastComputeGross = nodes.reduce(
    (sum, n) => sum + withVat(n.projected),
    0,
  );
  const runRate = activeMonthlyCents(now);
  const activeNodes = lives.filter((l) => l.endedAt === null).length;

  return mark({
    clusterId: clusterOf(params),
    clusterName: CLUSTER_NAME,
    provider: PROVIDER,
    region: REGION,
    currency: CURRENCY,
    billingPeriod: {
      start: new Date(month.start).toISOString(),
      end: new Date(month.end).toISOString(),
      totalHours: month.totalHours,
      elapsedHours: month.elapsedHours,
    },
    monthToDate: {
      totalGross: fixed4(computeGross + withVat(volumeCost)),
      totalNet: fixed4(compute + volumeCost),
      breakdown: {
        ...breakdown4(compute, volumeCost),
        computeGross: fixed4(computeGross),
      },
      nodes: nodes.map((n) => n.row),
      volumes: [
        mark({
          volumeProviderId: SHARED_VOLUME.id,
          kind: 'shared-storage',
          currentSizeGb: SHARED_VOLUME.sizeGb,
          status: 'active',
          costGross: fixed4(withVat(volumeCost)),
          costNet: fixed4(volumeCost),
        }),
      ],
      traffic: {
        outgoingBytes: month.elapsedHours * 75 * 1024 ** 2,
        ingoingBytes: month.elapsedHours * 30 * 1024 ** 2,
        includedBytes: activeNodes * INCLUDED_TRAFFIC_PER_MACHINE,
        overageBytes: 0,
        overageCostGross: fixed4(0),
        overageCostNet: fixed4(0),
      },
    },
    runRate: {
      monthlyGross: fixed2(withVat(runRate.compute) + withVat(runRate.storage)),
      monthlyNet: fixed2(runRate.compute + runRate.storage),
      breakdown: breakdown2(runRate.compute, runRate.storage),
      activeNodes,
      activeVolumes: 1,
    },
    forecast: {
      totalGross: fixed2(forecastComputeGross + withVat(volumeProjected)),
      totalNet: fixed2(forecastCompute + volumeProjected),
      breakdown: {
        ...breakdown2(forecastCompute, volumeProjected),
        computeGross: fixed2(forecastComputeGross),
      },
      remainingHours: month.remainingHours,
    },
    vat: { included: true, ratePercent: String(VAT_PERCENT) },
    billedAs: billingOf(PROVIDER)?.billedAs ?? null,
    unpricedItems: 0,
    listPricedItems: 0,
    calculatedAt: new Date(now).toISOString(),
  });
}
