const HOUR_MS = 3_600_000;

/** Excluding VAT, and including it where the provider states the rate; `gross` is null where it does not. */
export interface Amount {
  net: number;
  gross: number | null;
}

export const ZERO: Amount = { net: 0, gross: 0 };

/**
 * `recorded` is the price the node was bought at, stamped on its lifetime when
 * it started. `list` is the provider's list price today, used for a lifetime
 * that predates the stamp: close, but not proof of what was charged.
 */
export type PriceBasis = 'recorded' | 'list';

export interface NodeRate {
  hourlyNet: number;
  hourlyGross: number | null;
  monthlyNet: number | null;
  monthlyGross: number | null;
  basis: PriceBasis;
}

export interface VolumeRate {
  perGbMonthNet: number;
  perGbMonthGross: number | null;
}

export interface CalendarMonth {
  /** `YYYY-MM`, UTC. */
  key: string;
  start: Date;
  /** Exclusive: the first instant of the next month. */
  end: Date;
  hours: number;
}

export function calendarMonth(at: Date): CalendarMonth {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  return {
    key: `${start.getUTCFullYear()}-${month}`,
    start,
    end,
    hours: (end.getTime() - start.getTime()) / HOUR_MS,
  };
}

/** The `count` calendar months ending with the one `now` falls in, oldest first. */
export function monthsBack(now: Date, count: number): CalendarMonth[] {
  const out: CalendarMonth[] = [];
  for (let back = count - 1; back >= 0; back--) {
    out.push(
      calendarMonth(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)),
      ),
    );
  }
  return out;
}

/**
 * Milliseconds of a lifetime inside `[from, to)`. A lifetime still open runs
 * until `openUntil`: now for what was spent, the end of the month for what it
 * will cost.
 */
export function overlapMs(
  startedAt: Date,
  endedAt: Date | null | undefined,
  from: Date,
  to: Date,
  openUntil: Date,
): number {
  const end = Math.min((endedAt ?? openUntil).getTime(), to.getTime());
  const start = Math.max(startedAt.getTime(), from.getTime());
  return Math.max(0, end - start);
}

/** Every started hour is billed. */
export function billableHours(ms: number): number {
  return ms > 0 ? Math.ceil(ms / HOUR_MS) : 0;
}

function capped(
  hours: number,
  hourly: number,
  monthly: number | null,
  capsAtMonthly: boolean,
): number {
  const raw = hours * hourly;
  return capsAtMonthly && monthly !== null ? Math.min(raw, monthly) : raw;
}

/** The hours of one lifetime inside one calendar month, priced. */
export function nodeAmount(
  rate: NodeRate,
  hours: number,
  capsAtMonthly: boolean,
): Amount {
  return {
    net: capped(hours, rate.hourlyNet, rate.monthlyNet, capsAtMonthly),
    gross:
      rate.hourlyGross === null
        ? null
        : capped(hours, rate.hourlyGross, rate.monthlyGross, capsAtMonthly),
  };
}

/** A volume is charged per GB for the share of the month it existed. */
export function volumeAmount(
  rate: VolumeRate,
  sizeGb: number,
  ms: number,
  month: CalendarMonth,
): Amount {
  const fraction = ms / (month.hours * HOUR_MS);
  return {
    net: fraction * sizeGb * rate.perGbMonthNet,
    gross:
      rate.perGbMonthGross === null
        ? null
        : fraction * sizeGb * rate.perGbMonthGross,
  };
}

export function addAmount(a: Amount, b: Amount): Amount {
  return {
    net: a.net + b.net,
    gross: a.gross === null || b.gross === null ? null : a.gross + b.gross,
  };
}

/** Cents, for a figure a person reads; the sum is taken before rounding. */
export function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundAmount(a: Amount): Amount {
  return {
    net: toCents(a.net),
    gross: a.gross === null ? null : toCents(a.gross),
  };
}

export interface Lifetime {
  startedAt: Date;
  endedAt?: Date | null;
}

export interface MonthAccrual {
  spent: Amount;
  /** What the month will have cost at its end if what runs now keeps running; equal to `spent` for a closed month. */
  forecast: Amount;
  spentHours: number;
  forecastHours: number;
}

export function accrueNode(
  lifetime: Lifetime,
  rate: NodeRate,
  month: CalendarMonth,
  now: Date,
  capsAtMonthly: boolean,
): MonthAccrual {
  const until = now < month.end ? now : month.end;
  const spentHours = billableHours(
    overlapMs(lifetime.startedAt, lifetime.endedAt, month.start, until, now),
  );
  const forecastHours = billableHours(
    overlapMs(
      lifetime.startedAt,
      lifetime.endedAt,
      month.start,
      month.end,
      now < month.end ? month.end : now,
    ),
  );
  return {
    spent: nodeAmount(rate, spentHours, capsAtMonthly),
    forecast: nodeAmount(rate, forecastHours, capsAtMonthly),
    spentHours,
    forecastHours,
  };
}

export function accrueVolume(
  lifetime: Lifetime,
  sizeGb: number,
  rate: VolumeRate,
  month: CalendarMonth,
  now: Date,
): MonthAccrual {
  const until = now < month.end ? now : month.end;
  const spentMs = overlapMs(
    lifetime.startedAt,
    lifetime.endedAt,
    month.start,
    until,
    now,
  );
  const forecastMs = overlapMs(
    lifetime.startedAt,
    lifetime.endedAt,
    month.start,
    month.end,
    now < month.end ? month.end : now,
  );
  return {
    spent: volumeAmount(rate, sizeGb, spentMs, month),
    forecast: volumeAmount(rate, sizeGb, forecastMs, month),
    spentHours: spentMs / HOUR_MS,
    forecastHours: forecastMs / HOUR_MS,
  };
}
