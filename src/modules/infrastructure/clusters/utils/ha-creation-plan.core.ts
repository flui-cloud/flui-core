import { HaTopology } from '../../../providers/core/ha-topology';

/** A size as the provider's catalogue reports it, live for availability. */
export interface CatalogueShape {
  name: string;
  architecture?: string;
  availability?: Array<{ location: string; available: boolean }>;
  prices?: Array<{ location: string; priceMonthly?: { net?: string } }>;
}

export interface PlannedServer {
  zone: string;
  shape: string;
}

export interface HaCreationPlan {
  region: string;
  first: PlannedServer;
  /** The other servers, locations for data first: the order they join in. */
  servers: PlannedServer[];
  /** Locations left without a server, to add once they have one available. */
  later: string[];
}

export type HaCreationAnswer =
  | { plan: HaCreationPlan }
  | { plan: null; refusal: string; completeLaterHelps?: boolean };

const ALTERNATIVES_SHOWN = 3;

function listOf(items: string[]): string {
  return items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function availableIn(shape: CatalogueShape, zone: string): boolean {
  return (
    shape.availability?.some((a) => a.location === zone && a.available) ?? false
  );
}

function monthlyIn(shape: CatalogueShape, zone: string): number | null {
  const net = shape.prices?.find((p) => p.location === zone)?.priceMonthly?.net;
  const value = net === undefined ? Number.NaN : Number(net);
  return Number.isFinite(value) ? value : null;
}

function everywhere(
  catalogue: CatalogueShape[],
  zones: string[],
  architecture: string | undefined,
): string[] {
  return catalogue
    .filter((s) => !architecture || s.architecture === architecture)
    .filter((s) => zones.every((z) => availableIn(s, z)))
    .map((s) => ({ name: s.name, price: monthlyIn(s, zones[0]) }))
    .sort(
      (a, b) =>
        (a.price ?? Number.POSITIVE_INFINITY) -
        (b.price ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, ALTERNATIVES_SHOWN)
    .map((s) =>
      s.price === null ? s.name : `${s.name} (€${s.price.toFixed(2)}/month)`,
    );
}

interface PlanInput {
  topology: HaTopology | null;
  unsupported?: string;
  firstZone: string;
  workerCount: number;
  shapes: string[];
  catalogue: CatalogueShape[];
  completeLater: boolean;
}

/** Why the request cannot be planned before any size is looked at. */
function requestRefusal(input: PlanInput): string | null {
  const { topology } = input;
  if (!topology) {
    return (
      input.unsupported ??
      'Flui has no highly available layout for this region.'
    );
  }
  if (input.workerCount > 0) {
    return 'A cluster across three locations starts with its three servers; add workers once it is ready.';
  }
  if (!topology.dataZones.includes(input.firstZone)) {
    return `The first server goes in a location for data: ${topology.dataZones.join(' or ')}.`;
  }
  return input.shapes.length ? null : 'Name at least one size.';
}

function architecturesOf(
  shapes: string[],
  catalogue: CatalogueShape[],
): string[] {
  const known = shapes
    .map((name) => catalogue.find((s) => s.name === name))
    .filter((s): s is CatalogueShape => !!s);
  return [
    ...new Set(
      known.map((s) => s.architecture).filter((a): a is string => !!a),
    ),
  ];
}

function noneAvailable(
  missing: string[],
  shapes: string[],
  alternatives: string[],
  architecture: string | undefined,
): string {
  const verb = missing.length > 1 ? 'have' : 'has';
  const none = `${listOf(missing)} ${verb} none of ${shapes.join(', ')} available now.`;
  if (alternatives.length) {
    return `${none} Sizes every location has: ${alternatives.join(', ')}.`;
  }
  const kind = architecture ? `${architecture} ` : '';
  return `${none} No ${kind}size is available in all three locations right now.`;
}

/**
 * What a cluster across three locations is bought as, decided before anything
 * is bought: one server per location, each on the first size it has
 * available. The first server goes in a location for data, because that is
 * where the cluster's leader and primaries belong.
 */
export function planHaCreation(input: PlanInput): HaCreationAnswer {
  const refusal = requestRefusal(input);
  if (refusal) return { plan: null, refusal };
  const topology = input.topology!;
  const { firstZone, shapes, catalogue } = input;

  const architectures = architecturesOf(shapes, catalogue);
  if (architectures.length > 1) {
    return {
      plan: null,
      refusal: `These sizes mix ${architectures.join(' and ')}; a cluster runs on one architecture.`,
    };
  }

  const pick = (zone: string) =>
    shapes.find((name) => {
      const shape = catalogue.find((s) => s.name === name);
      return shape ? availableIn(shape, zone) : false;
    });
  const others = [
    ...topology.zones.filter(
      (z) => z !== firstZone && topology.dataZones.includes(z),
    ),
    ...topology.zones.filter((z) => !topology.dataZones.includes(z)),
  ];
  const firstShape = pick(firstZone);
  const missing = [firstZone, ...others].filter((z) => !pick(z));

  if (missing.length && (!firstShape || !input.completeLater)) {
    return {
      plan: null,
      completeLaterHelps: !!firstShape,
      refusal: noneAvailable(
        missing,
        shapes,
        everywhere(catalogue, topology.zones, architectures[0]),
        architectures[0],
      ),
    };
  }

  return {
    plan: {
      region: topology.region,
      first: { zone: firstZone, shape: firstShape! },
      servers: others
        .filter((z) => !missing.includes(z))
        .map((zone) => ({ zone, shape: pick(zone)! })),
      later: missing,
    },
  };
}
