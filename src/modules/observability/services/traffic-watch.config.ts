export interface TrafficWatchConfig {
  /** Public network interfaces, as a regular expression: private networks are not billed. */
  publicInterfaces: string;
  /** Sustained Mbit/s in either direction on one node's public interface. */
  nodeMbps: number;
  /** Share of the provider's included monthly traffic the current pace may reach. */
  monthlyTrafficPercent: number;
  /** Included monthly outgoing traffic, in TB, for every node; unset = the provider's own. */
  includedTrafficTb: number | null;
  /** Requests per second now, against the previous hours, that read as a surge. */
  spikeFactor: number;
  /** Below this many requests per second nothing is a surge. */
  spikeMinRps: number;
  /** Rate-limited requests (429) in ten minutes. */
  rateLimitedPer10m: number;
  /** Server errors as a share of requests in ten minutes, once there are enough requests. */
  edgeErrorPercent: number;
  edgeErrorMinRequests: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export function trafficWatchConfigFrom(
  get: (key: string) => string | undefined,
): TrafficWatchConfig {
  const included = get('FLUI_ALERT_INCLUDED_TRAFFIC_TB');
  return {
    publicInterfaces: get('FLUI_ALERT_PUBLIC_INTERFACES')?.trim() || 'eth0',
    nodeMbps: positive(get('FLUI_ALERT_NODE_MBPS'), 500),
    monthlyTrafficPercent: positive(
      get('FLUI_ALERT_MONTHLY_TRAFFIC_PERCENT'),
      80,
    ),
    includedTrafficTb:
      included && included.trim() !== '' ? positive(included, 0) : null,
    spikeFactor: positive(get('FLUI_ALERT_SPIKE_FACTOR'), 3),
    spikeMinRps: positive(get('FLUI_ALERT_SPIKE_MIN_RPS'), 5),
    rateLimitedPer10m: positive(get('FLUI_ALERT_RATE_LIMITED_PER_10M'), 20),
    edgeErrorPercent: positive(get('FLUI_ALERT_EDGE_ERROR_PERCENT'), 5),
    edgeErrorMinRequests: positive(
      get('FLUI_ALERT_EDGE_ERROR_MIN_REQUESTS'),
      100,
    ),
  };
}

/**
 * Outgoing traffic a server includes each month, in TB, as each provider
 * published it on 2026-10-09; null where it is not metered or not known.
 * Hetzner bills what goes over (about 1 EUR per TB); Contabo slows the port
 * instead; Scaleway instances and OVH in Europe do not meter it.
 */
export function includedMonthlyTrafficTb(
  provider: string,
  region: string,
): number | null {
  const p = provider.toLowerCase();
  const r = region.toLowerCase();
  if (p === 'hetzner') {
    if (r.startsWith('sin')) return 0.5;
    if (r.startsWith('ash') || r.startsWith('hil')) return 1;
    return 20;
  }
  if (p === 'contabo') return 32;
  return null;
}
