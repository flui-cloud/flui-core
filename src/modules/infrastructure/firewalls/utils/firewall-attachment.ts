export interface AttachmentNode {
  id: string;
  providerResourceId?: string | null;
}

export interface FirewallAttachment {
  checkedAt: string;
  attachedNodeIds: string[];
  missingNodeIds: string[];
  repairedNodeIds: string[];
  error?: string;
}

/** A node's server id as the provider knows it (`<zone>:<id>` keeps the id). */
export function serverIdOf(node: AttachmentNode): string | null {
  const raw = node.providerResourceId ?? '';
  const id = raw.split(':').at(-1);
  return id || null;
}

/** Which nodes the provider says the firewall covers, and which it does not. */
export function attachmentOf(
  nodes: AttachmentNode[],
  appliedServerIds: string[],
): { attached: AttachmentNode[]; missing: AttachmentNode[] } {
  const applied = new Set(appliedServerIds.map((s) => s.split(':').at(-1)));
  const attached: AttachmentNode[] = [];
  const missing: AttachmentNode[] = [];
  for (const node of nodes) {
    const id = serverIdOf(node);
    if (id && applied.has(id)) attached.push(node);
    else missing.push(node);
  }
  return { attached, missing };
}
