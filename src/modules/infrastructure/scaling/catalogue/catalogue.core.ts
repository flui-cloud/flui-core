/**
 * The vocabulary of the availability catalogue.
 *
 * The catalogue informs and never decides. It orders candidates and shortens
 * the fallback ladder; the provider still accepts or refuses the purchase with
 * the operator's own credentials, and a shape listed as up here can be refused
 * a second later.
 */

export const AVAILABILITY_STATES = [
  'available',
  'limited',
  'sold-out',
  'recovered',
] as const;

/**
 * Four, not two. `recovered` is a shape that is up everywhere again after
 * moving inside the observed window — the signal a patient order waits for,
 * and the reason it is worth keeping distinct from a shape that never moved.
 */
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const CATALOGUE_READINGS = [
  'read',
  'not-published',
  'not-covered',
  'unreachable',
  'no-market',
  'off',
] as const;

/**
 * Why the catalogue said what it said — six answers rather than a boolean,
 * because five of them are different sentences addressed to a person and only
 * one of them is data.
 *
 * `no-market` is the one this must never collapse into any other: on machines
 * the operator brings there is no market to read, which is not the same answer
 * as a market that came back empty.
 */
export type CatalogueReadingState = (typeof CATALOGUE_READINGS)[number];

export interface ShapeAvailability {
  shape: string;
  state: AvailabilityState;
  /**
   * True when the catalogue reports the shape up in every region it covers.
   *
   * Carried as a flag because the wire format drops the region list precisely
   * for these — reading the resulting empty list as "up nowhere" would invert
   * the answer.
   */
  everywhere: boolean;
  upIn: string[];
  downIn: string[];
}

export interface CatalogueReading {
  provider: string;
  state: CatalogueReadingState;
  /** Empty on every state but `read`, and never a claim that the market is empty. */
  shapes: ShapeAvailability[];
  /**
   * How old the reading is, counting the time it was held here.
   *
   * Null means nobody knows, and null is never replaced by a fresh-looking
   * zero: a cache passed off as a live reading is the one failure this must not
   * commit.
   */
  ageSeconds: number | null;
  stale: boolean;
}

export function unreadCatalogue(
  provider: string,
  state: CatalogueReadingState,
): CatalogueReading {
  return { provider, state, shapes: [], ageSeconds: null, stale: false };
}

/**
 * Where the shape can be had among the regions the group may buy in.
 *
 * An empty region list on the group means it named none, so nothing is excluded
 * — filtering against an empty allow-list would answer "nowhere" to a group
 * that may buy anywhere.
 */
export function upWhereAllowed(
  shape: ShapeAvailability,
  regions: string[],
): string[] {
  if (shape.everywhere) return regions;
  if (!regions.length) return shape.upIn;
  return shape.upIn.filter((region) => regions.includes(region));
}

/**
 * Absence is not unavailability.
 *
 * A shape the catalogue does not name outranks one it says is gone and is
 * outranked by one it says is up: not knowing narrows nothing, and it is not a
 * reason to walk past a rung the ladder still has.
 */
export function availabilityRank(
  shape: ShapeAvailability | null,
  regions: string[],
): number {
  if (!shape) return 1;
  if (shape.everywhere) return 0;
  return upWhereAllowed(shape, regions).length ? 0 : 2;
}
