import { toMacroRegion } from '@flui-cloud/infra';

/**
 * City-level decoration for OVH region codes.
 *
 * The *list* of regions comes from Keystone — the token's service catalog is
 * the only source that knows which regions a given credential can actually
 * reach. This table only supplies what Keystone does not carry: a city, a
 * country and a coordinate. An unknown code still resolves (to itself, with no
 * coordinate) rather than disappearing, which is the failure mode that hid
 * Milan, Paris and Roubaix while the region list itself was hard-coded.
 *
 * Keys are macro codes as produced by `toMacroRegion()`: `GRA11` collapses to
 * `GRA`, while `EU-SOUTH-MIL` and `RBX-A` carry no trailing digit and so stay
 * whole.
 */
export interface OvhRegionMeta {
  city: string;
  country: string;
  /** ISO 3166-1 alpha-2, used to decide whether a region counts as European. */
  cc: string;
  latitude: number;
  longitude: number;
}

const META: Record<string, OvhRegionMeta> = {
  GRA: {
    city: 'Gravelines',
    country: 'France',
    cc: 'FR',
    latitude: 50.9871,
    longitude: 2.1255,
  },
  SBG: {
    city: 'Strasbourg',
    country: 'France',
    cc: 'FR',
    latitude: 48.5734,
    longitude: 7.7521,
  },
  'RBX-A': {
    city: 'Roubaix',
    country: 'France',
    cc: 'FR',
    latitude: 50.6942,
    longitude: 3.1746,
  },
  'EU-WEST-PAR': {
    city: 'Paris',
    country: 'France',
    cc: 'FR',
    latitude: 48.8566,
    longitude: 2.3522,
  },
  'EU-SOUTH-MIL': {
    city: 'Milan',
    country: 'Italy',
    cc: 'IT',
    latitude: 45.4642,
    longitude: 9.19,
  },
  DE: {
    city: 'Frankfurt',
    country: 'Germany',
    cc: 'DE',
    latitude: 50.1109,
    longitude: 8.6821,
  },
  UK: {
    city: 'London',
    country: 'United Kingdom',
    cc: 'GB',
    latitude: 51.5074,
    longitude: -0.1278,
  },
  WAW: {
    city: 'Warsaw',
    country: 'Poland',
    cc: 'PL',
    latitude: 52.2297,
    longitude: 21.0122,
  },
  BHS: {
    city: 'Beauharnois',
    country: 'Canada',
    cc: 'CA',
    latitude: 45.3151,
    longitude: -73.8779,
  },
  SGP: {
    city: 'Singapore',
    country: 'Singapore',
    cc: 'SG',
    latitude: 1.3521,
    longitude: 103.8198,
  },
  SYD: {
    city: 'Sydney',
    country: 'Australia',
    cc: 'AU',
    latitude: -33.8688,
    longitude: 151.2093,
  },
};

/** The stable code Flui addresses a region by — what the user types after `--region`. */
export function ovhRegionCode(keystoneRegion: string): string {
  return toMacroRegion(keystoneRegion);
}

export function ovhRegionMeta(code: string): OvhRegionMeta | undefined {
  return META[code.toUpperCase()];
}

export const OVH_REGION_METADATA = META;
