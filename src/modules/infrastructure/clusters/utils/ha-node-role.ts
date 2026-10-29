/**
 * The part a node plays in a cluster across three locations, recorded when an
 * operator adds it for that part. A `server` also runs the control plane and
 * holds a vote in its datastore; a `data-host` holds copies of databases and
 * volumes. Neither is the master, which stays the first server.
 */
export type HaNodeRole = 'server' | 'data-host';

export const HA_NODE_ROLES: readonly HaNodeRole[] = ['server', 'data-host'];

export function haRoleOf(node: {
  metadata?: Record<string, unknown> | null;
}): HaNodeRole | null {
  const role = node.metadata?.haRole;
  return HA_NODE_ROLES.includes(role as HaNodeRole)
    ? (role as HaNodeRole)
    : null;
}

/** How K3s joins the node: only a `server` joins the control plane. */
export function k3sRoleOf(role: HaNodeRole | null): 'server' | 'agent' {
  return role === 'server' ? 'server' : 'agent';
}

/** The node record's metadata for its role; nothing for an ordinary worker. */
export function haRoleMetadata(role: HaNodeRole | null): {
  haRole?: HaNodeRole;
} {
  return role ? { haRole: role } : {};
}
