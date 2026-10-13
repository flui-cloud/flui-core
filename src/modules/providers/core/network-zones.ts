import { VNetTopology } from '../../management/entities/provider-capabilities.entity';

/**
 * The regions whose servers can join a network that sits in this zone, as the
 * provider declares them. Null when the declarations make no such claim: a
 * network that is not regional, or a provider that lists its zones only at
 * runtime.
 */
export function regionsServedByNetworkZone(
  topology: VNetTopology | null | undefined,
  networkZone: string,
): string[] | null {
  if (topology?.scope !== 'regional') return null;
  const zone = topology.zones.find((z) => z.id === networkZone);
  return zone?.coveredRegions?.length ? [...zone.coveredRegions] : null;
}

/** The declared zone a new network takes so that servers in this region can join it. */
export function networkZoneForRegion(
  topology: VNetTopology | null | undefined,
  region: string,
): string | null {
  if (topology?.scope !== 'regional') return null;
  return (
    topology.zones.find((z) => z.coveredRegions?.includes(region))?.id ?? null
  );
}
