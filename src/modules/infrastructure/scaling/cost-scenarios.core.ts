import { MONTH_HOURS, ShapeFactsReading } from './engine/engine.core';

/**
 * What a scaling group can cost, said as a consequence of its node limits.
 *
 * The limits are in nodes; money follows from them and from the provider's own
 * prices, and is shown as a handful of scenarios between "always at the
 * minimum" and "at the maximum all month". The spending ceiling sits under all
 * of it as a safety net the engine always enforces, and this is where a person
 * sees whether it would ever bite before the node limit does.
 *
 * Nothing here invents a price: a shape with no published price is named as
 * such and left out of every sum, and where nothing is priced there is no sum.
 */

export const PEAK_HOURS = 4;
export const DAYS_A_MONTH = 30;

export const COST_SCENARIO_KINDS = [
  'at-min',
  'short-peak',
  'daily-peak',
  'worst-case',
] as const;
export type CostScenarioKind = (typeof COST_SCENARIO_KINDS)[number];

export interface NodePrice {
  shape: string;
  region: string;
  hourlyEur: number | null;
  monthlyEur: number;
}

export interface CostScenario {
  kind: CostScenarioKind;
  label: string;
  lowEur: number | null;
  highEur: number | null;
}

export interface SpendingCeilingReading {
  monthlyEur: number | null;
  /** How many nodes of the dearest machine the ceiling lets the fleet reach. */
  nodesWithin: number | null;
  /** True where the ceiling stops the group before its node maximum. */
  stopsBeforeMax: boolean;
  says: string;
}

export interface ScalingCost {
  priced: boolean;
  says: string;
  cheapest: NodePrice | null;
  dearest: NodePrice | null;
  unpricedShapes: string[];
  scenarios: CostScenario[];
  ceiling: SpendingCeilingReading;
  /** A ceiling that covers the worst case, so it only ever stops a runaway. */
  suggestedCeilingEur: number | null;
}

export interface CostInput {
  provider: string;
  hasCatalogue: boolean;
  min: number;
  max: number;
  shapes: string[];
  /** Where the group may buy: its own list, or the cluster's region when it names none. */
  regions: string[];
  maxMonthlyCost: number | null;
  facts: ShapeFactsReading | null;
}

export function scalingCost(input: CostInput): ScalingCost {
  const blank = (says: string, unpricedShapes: string[] = []): ScalingCost => ({
    priced: false,
    says,
    cheapest: null,
    dearest: null,
    unpricedShapes,
    scenarios: [],
    ceiling: ceilingReading(input, null),
    suggestedCeilingEur: null,
  });

  if (!input.hasCatalogue) {
    return blank(
      `${input.provider} publishes no catalogue: Flui never sees a bill for these machines, so there is no cost to show.`,
    );
  }
  if (!input.shapes.length) {
    return blank('No machines are chosen, so there is no price to show.');
  }
  if (!input.facts?.read) {
    return blank(
      `The prices of ${input.provider} could not be read just now, so no cost can be shown.`,
    );
  }

  const { priced, unpriced } = pricesOf(input);
  if (!priced.length) {
    return blank(
      `${input.provider} publishes no price for ${listed(unpriced)} where this group may buy, so Flui cannot say what it costs.`,
      unpriced,
    );
  }

  const cheapest = priced.reduce(
    (a, b) => (b.monthlyEur < a.monthlyEur ? b : a),
    priced[0],
  );
  const dearest = priced.reduce(
    (a, b) => (b.monthlyEur > a.monthlyEur ? b : a),
    priced[0],
  );
  const scenarios = scenariosOf(input, cheapest, dearest);
  const worst = scenarios.find((s) => s.kind === 'worst-case');
  const suggested =
    worst?.highEur === null || worst?.highEur === undefined
      ? null
      : Math.ceil(worst.highEur);

  const perNode =
    cheapest === dearest || cheapest.monthlyEur === dearest.monthlyEur
      ? `Priced on ${machine(cheapest)}`
      : `Priced between ${machine(cheapest)} and ${machine(dearest)}`;
  const missing = unpricedNote(unpriced);

  return {
    priced: true,
    says: `${perNode}, the provider's list price.${missing}`,
    cheapest,
    dearest,
    unpricedShapes: unpriced,
    scenarios,
    ceiling: ceilingReading(input, { cheapest, dearest, worst: worst ?? null }),
    suggestedCeilingEur: suggested,
  };
}

function pricesOf(input: CostInput): {
  priced: NodePrice[];
  unpriced: string[];
} {
  const priced: NodePrice[] = [];
  const unpriced: string[] = [];
  for (const shape of input.shapes) {
    const fact = input.facts?.shapes.find((entry) => entry.shape === shape);
    const inRegion = (fact?.prices ?? []).filter(
      (price) => !input.regions.length || input.regions.includes(price.region),
    );
    const points = inRegion
      .map((price) => {
        const monthly =
          price.monthlyEur ??
          (price.hourlyEur === null ? null : price.hourlyEur * MONTH_HOURS);
        return monthly === null
          ? null
          : {
              shape,
              region: price.region,
              hourlyEur: price.hourlyEur,
              monthlyEur: monthly,
            };
      })
      .filter((point): point is NodePrice => point !== null);
    if (points.length) priced.push(...points);
    else unpriced.push(shape);
  }
  return { priced, unpriced };
}

function scenariosOf(
  input: CostInput,
  cheapest: NodePrice,
  dearest: NodePrice,
): CostScenario[] {
  const min = Math.max(0, input.min);
  const max = Math.max(min, input.max);
  const extra = max - min;
  const scenario = (
    kind: CostScenarioKind,
    label: string,
    of: (price: NodePrice) => number | null,
  ): CostScenario => ({
    kind,
    label,
    lowEur: roundOrNull(of(cheapest)),
    highEur: roundOrNull(of(dearest)),
  });
  const atMin = (price: NodePrice) => min * price.monthlyEur;
  const peak = (hours: number) => (price: NodePrice) =>
    price.hourlyEur === null
      ? null
      : atMin(price) +
        extra * Math.min(hours * price.hourlyEur, price.monthlyEur);

  const out: CostScenario[] = [
    scenario('at-min', `Always at the minimum, ${nodes(min)}`, atMin),
  ];
  if (extra > 0) {
    out.push(
      scenario(
        'short-peak',
        `At the maximum (${nodes(max)}) for ${PEAK_HOURS} hours, once`,
        peak(PEAK_HOURS),
      ),
      scenario(
        'daily-peak',
        `At the maximum (${nodes(max)}) ${PEAK_HOURS} hours a day`,
        peak(PEAK_HOURS * DAYS_A_MONTH),
      ),
    );
  }
  out.push(
    scenario(
      'worst-case',
      `At the maximum (${nodes(max)}) all month`,
      (price) => max * price.monthlyEur,
    ),
  );
  return out;
}

function ceilingReading(
  input: CostInput,
  priced: {
    cheapest: NodePrice;
    dearest: NodePrice;
    worst: CostScenario | null;
  } | null,
): SpendingCeilingReading {
  const cap = input.maxMonthlyCost;
  if (typeof cap !== 'number' || cap <= 0) {
    return {
      monthlyEur: null,
      nodesWithin: null,
      stopsBeforeMax: false,
      says: 'No spending ceiling. Buying on its own needs one: it is the safety net the engine checks before every purchase.',
    };
  }
  if (!priced) {
    return {
      monthlyEur: cap,
      nodesWithin: null,
      stopsBeforeMax: false,
      says: `Spending ceiling €${money(cap)} a month, checked before every purchase against the list price of the whole fleet.`,
    };
  }
  const within = Math.floor(cap / priced.dearest.monthlyEur + 1e-9);
  const worst = priced.worst?.highEur ?? null;
  if (worst !== null && cap >= worst) {
    return {
      monthlyEur: cap,
      nodesWithin: within,
      stopsBeforeMax: false,
      says: `Spending ceiling €${money(cap)} a month, above the worst case of €${money(worst)}: the node limits decide, and the ceiling only stops a runaway.`,
    };
  }
  return {
    monthlyEur: cap,
    nodesWithin: within,
    stopsBeforeMax: within < input.max,
    says:
      within < input.max
        ? `Spending ceiling €${money(cap)} a month, below the worst case: the engine stops buying at about ${nodes(within)} of ${priced.dearest.shape} (€${money(priced.dearest.monthlyEur)} a month each), before the maximum of ${input.max}.`
        : `Spending ceiling €${money(cap)} a month, checked before every purchase against the list price of the whole fleet.`,
  };
}

function machine(price: NodePrice): string {
  const hourly =
    price.hourlyEur === null ? '' : `€${price.hourlyEur.toFixed(4)}/h, `;
  return `${price.shape} (${hourly}€${money(price.monthlyEur)} a month)`;
}

function nodes(count: number): string {
  return count === 1 ? '1 node' : `${count} nodes`;
}

function listed(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function unpricedNote(unpriced: string[]): string {
  if (!unpriced.length) return '';
  const one = unpriced.length === 1;
  return ` ${listed(unpriced)} ${one ? 'has' : 'have'} no published price and ${one ? 'is' : 'are'} not counted.`;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export function money(value: number): string {
  return value.toFixed(2);
}
