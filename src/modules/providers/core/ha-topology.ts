/**
 * A layout a cluster can take to survive the loss of a whole location: one
 * control-plane server in each of three locations, and copies of data in the
 * locations close enough to confirm a write together.
 */
export interface HaTopology {
  region: string;
  zones: [string, string, string];
  /** Where copies of data live, and where leaders and primaries belong. */
  dataZones: string[];
  /** False when a person forced a region Flui has not validated. */
  validated: boolean;
}

export type HaTopologyResolution =
  | { topology: HaTopology }
  | { topology: null; reason: string };

/**
 * The validated layout for a cluster's region. A region Flui has not measured
 * is refused unless forced, and a forced one treats its three locations as
 * equal, because nothing says which of them are close.
 */
export function resolveHaTopology(
  declared: HaTopology[],
  region: string | undefined,
  zonesWithServers: string[],
  force = false,
): HaTopologyResolution {
  if (!region) {
    return {
      topology: null,
      reason:
        'No node of this cluster reports its region yet, so Flui cannot tell which layout applies.',
    };
  }
  const validated = declared.find((t) => t.region === region);
  if (validated) return { topology: validated };
  const zones = [...new Set(zonesWithServers)].sort((a, b) =>
    a.localeCompare(b),
  );
  if (!force) {
    return {
      topology: null,
      reason: `Flui has not validated a highly available layout for ${region} yet. It can be forced, with no promise about how far apart its locations are.`,
    };
  }
  if (zones.length !== 3) {
    return {
      topology: null,
      reason: `A forced layout needs servers in exactly three locations of ${region}; this cluster has them in ${zones.length}.`,
    };
  }
  return {
    topology: {
      region,
      zones: zones as [string, string, string],
      dataZones: zones,
      validated: false,
    },
  };
}
