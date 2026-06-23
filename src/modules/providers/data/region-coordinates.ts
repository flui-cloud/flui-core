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
