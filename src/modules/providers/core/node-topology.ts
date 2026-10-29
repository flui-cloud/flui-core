export const TOPOLOGY_ZONE_LABEL = 'topology.kubernetes.io/zone';
export const TOPOLOGY_REGION_LABEL = 'topology.kubernetes.io/region';

/**
 * Where a node sits, in the terms the standard Kubernetes topology labels use.
 * `zone` is the place one outage takes down as a whole (a Hetzner location, a
 * Scaleway zone); `region` is the group of zones a private network can span.
 */
export interface NodeTopology {
  zone: string;
  region: string;
}

const LABEL_CHARS_RE = /^[a-z0-9._-]+$/;
const ALPHANUMERIC_RE = /^[a-z0-9]$/;

/** Lowercase only, although Kubernetes allows capitals: every provider location Flui knows is lowercase. */
export function isTopologyLabelValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 63 &&
    LABEL_CHARS_RE.test(value) &&
    ALPHANUMERIC_RE.test(value[0]) &&
    ALPHANUMERIC_RE.test(value.at(-1) ?? '')
  );
}

/** The labels a node carries for its topology, or none when either part is not a valid label value. */
export function topologyLabels(
  topology: NodeTopology | null | undefined,
): Record<string, string> {
  if (!topology) return {};
  if (
    !isTopologyLabelValue(topology.zone) ||
    !isTopologyLabelValue(topology.region)
  ) {
    return {};
  }
  return {
    [TOPOLOGY_ZONE_LABEL]: topology.zone,
    [TOPOLOGY_REGION_LABEL]: topology.region,
  };
}

/**
 * The labels to add so a node carries its topology. A label already set to
 * another value is left alone and reported: it was put there by someone, and
 * overwriting it would move workloads that rely on it.
 */
export function missingTopologyLabels(
  current: Record<string, string>,
  desired: Record<string, string>,
): { add: Record<string, string>; conflicts: string[] } {
  const add: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(desired)) {
    if (current[key] === undefined) add[key] = value;
    else if (current[key] !== value) conflicts.push(`${key}=${current[key]}`);
  }
  return { add, conflicts };
}
