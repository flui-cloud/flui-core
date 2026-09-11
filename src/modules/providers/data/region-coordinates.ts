import { CloudProvider } from '../enums/cloud-provider.enum';

export interface RegionCoordinates {
  latitude: number;
  longitude: number;
}

const COORDINATES: Record<CloudProvider, Record<string, RegionCoordinates>> = {
  [CloudProvider.HETZNER]: {
    fsn1: { latitude: 50.4777, longitude: 12.3649 },
    nbg1: { latitude: 49.4521, longitude: 11.0767 },
    hel1: { latitude: 60.1699, longitude: 24.9384 },
  },
  [CloudProvider.SCALEWAY]: {
    'fr-par': { latitude: 48.8566, longitude: 2.3522 },
    'nl-ams': { latitude: 52.3676, longitude: 4.9041 },
    'pl-waw': { latitude: 52.2297, longitude: 21.0122 },
  },
  [CloudProvider.CONTABO]: {
    EU: { latitude: 48.9737, longitude: 8.1764 },
    'EU-1': { latitude: 49.4521, longitude: 11.0767 },
    'EU-2': { latitude: 48.1351, longitude: 11.582 },
    UK: { latitude: 50.8198, longitude: -1.0879 },
  },
  // Macro-region (city-level) coordinates — same source as OVH_REGIONS in
  // @flui-cloud/infra, which OvhCapabilitiesService.getAvailableRegions() uses.
  [CloudProvider.OVH]: {
    GRA: { latitude: 50.9871, longitude: 2.1255 },
    SBG: { latitude: 48.5734, longitude: 7.7521 },
    DE: { latitude: 50.1109, longitude: 8.6821 },
    UK: { latitude: 51.5074, longitude: -0.1278 },
    WAW: { latitude: 52.2297, longitude: 21.0122 },
    BHS: { latitude: 45.3151, longitude: -73.8779 },
    SGP: { latitude: 1.3521, longitude: 103.8198 },
    SYD: { latitude: -33.8688, longitude: 151.2093 },
  },
  // BYOS has no provider-defined regions — the operator's host has its own
  // location, unknown to Flui.
  [CloudProvider.BYOS]: {},
};

export function getRegionCoordinates(
  provider: CloudProvider,
  regionId: string,
): RegionCoordinates | undefined {
  return COORDINATES[provider]?.[regionId];
}
