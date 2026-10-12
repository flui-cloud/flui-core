export interface MigrationBridge {
  mode: 'bridge' | 'dns-only';
  skipReason: string | null;
  state: 'preparing' | 'active' | 'closed' | null;
  hosts: {
    fqdn: string;
    certificate: string | null;
    certificateReady: boolean;
  }[];
  activatedAt?: string | null;
  dnsFlippedAt?: string | null;
  closedAt?: string | null;
  recordTtlSeconds?: number | null;
  ageSeconds?: number | null;
  closableAt: string | null;
  readyToClose: boolean;
  blockedBy?: 'ttl' | 'dns' | null;
  leftover?: string | null;
  summary: string;
}

/** Label/value rows for `migrate app|full show`, straight from the API's bridge block. */
export function bridgeRows(
  bridge: MigrationBridge | null | undefined,
): [string, string][] {
  if (!bridge) return [];
  if (bridge.mode === 'dns-only') {
    return [
      ['Bridge', 'none (DNS only)'],
      ...(bridge.skipReason
        ? [['Why', bridge.skipReason] as [string, string]]
        : []),
    ];
  }
  const state =
    bridge.state === 'active' && bridge.ageSeconds != null
      ? `active, open for ${duration(bridge.ageSeconds)}`
      : (bridge.state ?? 'planned');
  const rows: [string, string][] = [['Bridge', state]];
  if (bridge.hosts.length) {
    rows.push([
      'Names',
      bridge.hosts
        .map(
          (h) =>
            `${h.fqdn} (certificate: ${h.certificate ?? 'none'}${
              h.certificateReady ? '' : ', not ready'
            })`,
        )
        .join(', '),
    ]);
  }
  if (bridge.dnsFlippedAt) rows.push(['DNS moved', bridge.dnsFlippedAt]);
  if (bridge.state === 'active') {
    rows.push(['Closable', closableWhen(bridge)]);
  }
  rows.push(['', bridge.summary]);
  return rows;
}

function closableWhen(bridge: MigrationBridge): string {
  if (bridge.readyToClose) return 'now';
  if (bridge.closableAt) return `from ${bridge.closableAt}`;
  return 'after the DNS switch';
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60 ? `${minutes % 60}m` : '';
  return `${Math.floor(minutes / 60)}h${rest}`;
}
