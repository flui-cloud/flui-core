export type BridgeMode = 'bridge' | 'dns-only';

export type BridgeState = 'preparing' | 'active' | 'closed';

/**
 * Where the destination gets the certificate the bridged clients will verify:
 * already there, issued through DNS-01 for the name, the destination's own
 * wildcard, or a copy of the source's secret.
 */
export type BridgeCertificateSource =
  | 'present'
  | 'dns-01'
  | 'wildcard'
  | 'copied';

/** One forwarded hostname: routing on the source is per host, not per path. */
export interface BridgeHost {
  fqdn: string;
  namespace: string;
  endpointIds: string[];
  certificateRequired: boolean;
  secretName: string | null;
  certificate: BridgeCertificateSource | null;
  certificateReady: boolean;
  certificateMessage: string | null;
  /** What Flui did when the certificate authority refused the name, for every surface to show. */
  certificateNote?: string | null;
  /** cert-manager backoffs reset during this preparation, and the failure last acted on. */
  certificateRetry?: { resets: number; failedAt: string | null };
}

export interface MigrationBridgeState {
  mode: BridgeMode;
  skipReason: string | null;
  state: BridgeState | null;
  hosts: BridgeHost[];
  /** The destination route was built before READY, so activation does not wait for it. */
  routePrepared?: boolean;
  targetAddresses?: string[];
  recordTtlSeconds?: number | null;
  preparedAt?: string;
  activatedAt?: string;
  /** The source no longer routes the names itself: only from here does the bridge carry them. */
  sourceRouteRemovedAt?: string;
  dnsFlippedAt?: string;
  closedAt?: string;
  leftover?: string | null;
}

export interface BridgeVerdict {
  mode: BridgeMode;
  skipReason: string | null;
}
