/**
 * What the example fleet costs, and how it changed this month.
 *
 * Pricing, Scaling and Storage all describe the same machines and the
 * same shared volume, and the one worker the scaling group added for a busy
 * afternoon and gave back after a quiet night. Declared once, here, so the
 * bill shows the machine the decision history talks about, for the hours the
 * decision history says it ran.
 *
 * Every amount is worked in whole ten-thousandths of a euro (and the monthly
 * figures in whole cents), the way the real bill rounds them, so a total is
 * always exactly the sum of the lines under it.
 */
import { MACHINES } from './sandbox-world-core';

export const CURRENCY = 'EUR';
export const VAT_PERCENT = 19;

/** List prices of the shapes the example fleet uses, excluding VAT. */
export const SERVER_PRICES = {
  CX33: { serverType: 'cx33', hourlyNet: 0.0099, monthlyNet: 5.99 },
  CX43: { serverType: 'cx43', hourlyNet: 0.0193, monthlyNet: 11.99 },
} as const;

export type ExampleShape = keyof typeof SERVER_PRICES;

/** The shared volume on the master, the one disk every application's data lives on. */
export const SHARED_VOLUME = {
  id: 'example-volume-1',
  sizeGb: 60,
  monthlyNetPerGb: 0.044,
} as const;

export const MACHINES_SINCE_DAYS = 26;
const HOUR = 3_600_000;

/**
 * The worker added on a busy afternoon and given back the next morning. It is
 * the reason the decision history has a purchase and a removal in it, and the
 * reason Pricing lists one removed machine.
 */
export const BURST_WORKER = {
  id: 'example-server-4',
  name: 'production-4',
  role: 'worker',
  productName: 'CX43' as ExampleShape,
  addedHoursAgo: 150,
  removedHoursAgo: 129,
} as const;

export interface FleetLifetime {
  id: string;
  name: string;
  role: string;
  shape: ExampleShape;
  startedAt: number;
  endedAt: number | null;
}

export function fleetLifetimes(now: number): FleetLifetime[] {
  return [
    ...MACHINES.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      shape: m.productName as ExampleShape,
      startedAt: now - MACHINES_SINCE_DAYS * 24 * HOUR,
      endedAt: null,
    })),
    {
      id: BURST_WORKER.id,
      name: BURST_WORKER.name,
      role: BURST_WORKER.role,
      shape: BURST_WORKER.productName,
      startedAt: now - BURST_WORKER.addedHoursAgo * HOUR,
      endedAt: now - BURST_WORKER.removedHoursAgo * HOUR,
    },
  ];
}

export interface BillingMonth {
  start: number;
  end: number;
  totalHours: number;
  elapsedHours: number;
  remainingHours: number;
}

export function billingMonth(now: number): BillingMonth {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    0,
    23,
    59,
    59,
    999,
  );
  return {
    start,
    end,
    totalHours: Math.ceil((end - start) / HOUR),
    elapsedHours: Math.ceil((now - start) / HOUR),
    remainingHours: Math.max(0, Math.floor((end - now) / HOUR)),
  };
}

/** Billable hours of a lifetime inside this month so far; a started hour counts. */
export function hoursThisMonth(
  life: { startedAt: number; endedAt: number | null },
  month: BillingMonth,
  now: number,
): number {
  const from = Math.max(life.startedAt, month.start);
  const to = Math.min(life.endedAt ?? now, now);
  return to > from ? Math.ceil((to - from) / HOUR) : 0;
}

/** Hourly, never more than the monthly price in one month. In ten-thousandths. */
export function nodeCost4(shape: ExampleShape, hours: number): number {
  const price = SERVER_PRICES[shape];
  return Math.round(Math.min(hours * price.hourlyNet, price.monthlyNet) * 1e4);
}

export function volumeMonthlyNet(): number {
  return SHARED_VOLUME.sizeGb * SHARED_VOLUME.monthlyNetPerGb;
}

/** The volume is billed pro rata over the month. In ten-thousandths. */
export function volumeCost4(hours: number, month: BillingMonth): number {
  return Math.round(
    Math.min(1, hours / month.totalHours) * volumeMonthlyNet() * 1e4,
  );
}

export const withVat = (net: number): number =>
  Math.round(net * (1 + VAT_PERCENT / 100));

export const fixed4 = (tenThousandths: number): string =>
  (tenThousandths / 1e4).toFixed(4);

export const fixed2 = (cents: number): string => (cents / 100).toFixed(2);

/** What the fleet that runs now costs over a whole month, in cents, excluding VAT. */
export function activeMonthlyCents(now: number): {
  compute: number;
  storage: number;
} {
  const compute = fleetLifetimes(now)
    .filter((l) => l.endedAt === null)
    .reduce(
      (sum, l) => sum + Math.round(SERVER_PRICES[l.shape].monthlyNet * 100),
      0,
    );
  return { compute, storage: Math.round(volumeMonthlyNet() * 100) };
}
