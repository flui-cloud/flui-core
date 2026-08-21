import { ClusterZoneAssignment, DnsClient, DnsZone } from './dns-client';

/**
 * A cluster may publish under more than one zone, so every cluster-scoped DNS
 * verb has the same question to answer first: which assignment. One zone means
 * no flag; more than one means naming it, never guessing.
 */
export async function resolveAssignment(
  dns: DnsClient,
  cluster: { id: string; name: string },
  zoneRef?: string,
): Promise<ClusterZoneAssignment> {
  const assignments = await dns.listAssignments(cluster.id);

  if (assignments.length === 0) {
    throw new Error(
      `${cluster.name} has no DNS zone assigned. ` +
        'Assign one with `flui dns zone assign <zone>`.',
    );
  }

  if (zoneRef) {
    const needle = zoneRef.toLowerCase();
    const match = assignments.find(
      (a) =>
        a.id === zoneRef ||
        a.dnsZoneId === zoneRef ||
        a.dnsZone.zoneName.toLowerCase() === needle,
    );
    if (!match) {
      throw new Error(
        `Zone "${zoneRef}" is not assigned to ${cluster.name}. Assigned:\n` +
          assignments
            .map((a) => `  • ${a.dnsZone.zoneName}  (${a.id})`)
            .join('\n'),
      );
    }
    return match;
  }

  if (assignments.length === 1) return assignments[0];

  throw new Error(
    `${cluster.name} publishes under several zones. ` +
      'Name one with --zone <name-or-id>:\n' +
      assignments.map((a) => `  • ${a.dnsZone.zoneName}  (${a.id})`).join('\n'),
  );
}

/** Resolves a registered zone by name or id, for the assign verb. */
export async function resolveZone(
  dns: DnsClient,
  zoneRef: string,
): Promise<DnsZone> {
  const zones = await dns.listZones();
  const needle = zoneRef.toLowerCase();
  const match = zones.find(
    (z) => z.id === zoneRef || z.zoneName.toLowerCase() === needle,
  );
  if (!match) {
    if (zones.length === 0) {
      throw new Error(
        'No DNS zones are registered. Register one before assigning it.',
      );
    }
    throw new Error(
      `DNS zone "${zoneRef}" not found. Registered zones:\n` +
        zones.map((z) => `  • ${z.zoneName}  (${z.id})`).join('\n'),
    );
  }
  return match;
}
