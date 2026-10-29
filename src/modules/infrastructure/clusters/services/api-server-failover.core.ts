const CONTROL_PLANE_LABEL = 'node-role.kubernetes.io/control-plane';

export interface KnownApiServer {
  nodeId: string;
  name: string;
  address: string;
}

interface NodeLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: { conditions?: Array<{ type: string; status: string }> };
}

interface RecordedNode {
  id: string;
  serverName?: string;
  nodeType?: string;
}

/**
 * The servers the cluster reports, joined to Flui's records and to the overlay
 * address each one answers on. The master comes first, the order the sweep
 * tries them in.
 */
export function knownApiServers(
  nodes: NodeLike[],
  recorded: RecordedNode[],
  overlayOf: Map<string, string>,
): KnownApiServer[] {
  const servers = new Set(
    nodes
      .filter((n) => n.metadata?.labels?.[CONTROL_PLANE_LABEL] === 'true')
      .map((n) => n.metadata!.name!),
  );
  return recorded
    .filter((r) => r.serverName && servers.has(r.serverName))
    .filter((r) => overlayOf.has(r.id))
    .sort(
      (a, b) =>
        Number(b.nodeType === 'master') - Number(a.nodeType === 'master') ||
        a.serverName!.localeCompare(b.serverName!),
    )
    .map((r) => ({
      nodeId: r.id,
      name: r.serverName!,
      address: overlayOf.get(r.id)!,
    }));
}

export function readyServerCount(nodes: NodeLike[]): number {
  return nodes.filter(
    (n) =>
      n.metadata?.labels?.[CONTROL_PLANE_LABEL] === 'true' &&
      (n.status?.conditions ?? []).some(
        (c) => c.type === 'Ready' && c.status === 'True',
      ),
  ).length;
}

export function sameServers(a: KnownApiServer[], b: KnownApiServer[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.nodeId === b[i].nodeId && s.address === b[i].address)
  );
}
