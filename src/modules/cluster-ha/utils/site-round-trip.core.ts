export interface SiteRoundTrip {
  from: string;
  to: string;
  /** Average of three pings; null when the other location did not answer. */
  ms: number | null;
}

export interface SiteServer {
  zone: string;
  node: string;
  address: string;
}

/** One server per location, the first by name, so the pairs stay the same between sweeps. */
export function serverPerZone(servers: SiteServer[]): SiteServer[] {
  const byZone = new Map<string, SiteServer>();
  for (const s of [...servers].sort((a, b) => a.node.localeCompare(b.node))) {
    if (!byZone.has(s.zone)) byZone.set(s.zone, s);
  }
  return [...byZone.values()].sort((a, b) => a.zone.localeCompare(b.zone));
}

/** Each location measures the ones after it: three locations, three pairs, two probes. */
export function roundTripPlan(
  servers: SiteServer[],
): { from: SiteServer; to: SiteServer[] }[] {
  const zones = serverPerZone(servers);
  return zones
    .map((from, i) => ({ from, to: zones.slice(i + 1) }))
    .filter((p) => p.to.length > 0);
}

export function pingScript(addresses: string[]): string {
  return addresses
    .map((a) => `echo "${a} $(ping -c 3 -W 2 -q ${a} 2>/dev/null | tail -1)"`)
    .join('\n');
}

/** Reads busybox's `round-trip min/avg/max = 0.4/0.5/0.6 ms`, one line per address. */
export function parsePingOutput(output: string): Map<string, number | null> {
  const result = new Map<string, number | null>();
  for (const line of output.split('\n')) {
    const [address, ...rest] = line.trim().split(' ');
    if (!address) continue;
    const avg = /=\s*[\d.]+\/([\d.]+)\//.exec(rest.join(' '))?.[1];
    result.set(address, avg === undefined ? null : Number(avg));
  }
  return result;
}
