export interface InstancePod {
  name: string;
  node?: string;
  ready: boolean;
}

export type PrimaryPlacement =
  | { move: false; reason: string }
  | { move: true; target: string };

/** Long enough that a switchover never chases a primary that is still settling. */
export const PRIMARY_MOVE_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Whether the primary sits outside the locations writes are confirmed fastest
 * from, and which copy to switch over to. Only on a healthy cluster with every
 * instance ready, so a switchover never runs in the middle of a failover.
 */
export function primaryPlacement(input: {
  primary: string | undefined;
  phase: string | undefined;
  instances: number;
  readyInstances: number;
  pods: InstancePod[];
  zoneOf: Map<string, string>;
  preferredZones: string[];
  lastMovedAt?: string;
  now: number;
}): PrimaryPlacement {
  if (input.phase !== 'Cluster in healthy state') {
    return { move: false, reason: 'not healthy' };
  }
  if (input.readyInstances < input.instances) {
    return { move: false, reason: 'an instance is not ready' };
  }
  const primary = input.pods.find((p) => p.name === input.primary);
  const zone = primary?.node ? input.zoneOf.get(primary.node) : undefined;
  if (!primary || !zone) return { move: false, reason: 'primary not placed' };
  if (input.preferredZones.includes(zone)) {
    return { move: false, reason: 'already in place' };
  }
  const last = input.lastMovedAt ? Date.parse(input.lastMovedAt) : Number.NaN;
  if (!Number.isNaN(last) && input.now - last < PRIMARY_MOVE_COOLDOWN_MS) {
    return { move: false, reason: 'moved recently' };
  }
  const target = input.pods
    .filter(
      (p) =>
        p.name !== primary.name &&
        p.ready &&
        !!p.node &&
        input.preferredZones.includes(input.zoneOf.get(p.node) ?? ''),
    )
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!target)
    return { move: false, reason: 'no copy ready in a location for data' };
  return { move: true, target: target.name };
}
