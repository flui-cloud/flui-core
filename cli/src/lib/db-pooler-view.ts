export interface DbPoolerStatus {
  enabled: boolean;
  mode: 'transaction' | 'session' | null;
  replicas: number;
  image: string | null;
  upstream: 'local' | 'forward' | null;
  routed: boolean;
  reason: string | null;
  addresses: { pooled: string | null; direct: string };
  pods: Array<{ name: string; ready: boolean }>;
}

/** The pooler of a database as lines a person reads; the API decided every fact. */
export function poolerLines(s: DbPoolerStatus): string[] {
  if (!s.enabled) {
    return [
      'No connection pooler: apps connect to the database directly.',
      `direct   ${s.addresses.direct}   (FLUI_CONNECTION_URL and FLUI_DIRECT_URL)`,
    ];
  }
  const ready = s.pods.filter((p) => p.ready).length;
  const lines = [
    `pooler   ${s.mode} mode, ${ready}/${s.replicas} ready${s.upstream === 'forward' ? ', forwarding to another cluster' : ''}`,
    `image    ${s.image ?? 'unknown'}`,
  ];
  if (s.routed) {
    lines.push(
      `pooled   ${s.addresses.pooled}   (FLUI_CONNECTION_URL)`,
      `direct   ${s.addresses.direct}   (FLUI_DIRECT_URL: migrations, LISTEN, admin tools)`,
    );
  } else {
    lines.push(
      `direct   ${s.addresses.direct}   (FLUI_CONNECTION_URL and FLUI_DIRECT_URL for now)`,
      s.reason ??
        'The pooler is being set up; apps connect directly until it is ready.',
    );
  }
  return lines;
}
