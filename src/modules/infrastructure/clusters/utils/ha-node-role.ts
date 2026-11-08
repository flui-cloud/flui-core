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

const CONTROL_PLANE_LABEL = 'node-role.kubernetes.io/control-plane';

/**
 * Why a node asked to join as a server did not become one. The join script
 * of an older release ignores the role and joins an agent, which K3s accepts
 * without complaint, so only the labels of the node that joined tell.
 */
export function serverJoinRefusal(
  nodeName: string,
  k3sRole: 'server' | 'agent',
  labels: Record<string, string> | null | undefined,
): string | null {
  if (k3sRole !== 'server') return null;
  if (labels?.[CONTROL_PLANE_LABEL] === 'true') return null;
  return `${nodeName} joined as an ordinary worker, not as a server of the control plane: the bootstrap scripts this installation uses do not join servers. It stays a worker and can be removed.`;
}

/** The node record's metadata for its role; nothing for an ordinary worker. */
export function haRoleMetadata(role: HaNodeRole | null): {
  haRole?: HaNodeRole;
} {
  return role ? { haRole: role } : {};
}
