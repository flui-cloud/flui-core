import {
  BridgeCertificateSource,
  BridgeMode,
  BridgeState,
  MigrationBridgeState,
} from '../../dns/interfaces/migration-bridge.interface';

/** Used when the record's TTL could not be read before the switch. */
export const DEFAULT_RECORD_TTL_SECONDS = 300;

export interface MigrationBridgeView {
  mode: BridgeMode;
  skipReason: string | null;
  state: BridgeState | null;
  hosts: {
    fqdn: string;
    certificate: BridgeCertificateSource | null;
    certificateReady: boolean;
    certificateNote?: string;
  }[];
  activatedAt: string | null;
  dnsFlippedAt: string | null;
  closedAt: string | null;
  recordTtlSeconds: number | null;
  ageSeconds: number | null;
  closableAt: string | null;
  readyToClose: boolean;
  blockedBy: 'ttl' | 'dns' | null;
  leftover: string | null;
  summary: string;
}

/**
 * The bridge of a migration as every surface shows it. A client may still use
 * an answer cached before the switch for one TTL, and a resolver that fetched
 * it just before the switch for one more: the bridge is safe to close two TTLs
 * after the record moved.
 */
export function bridgeView(
  mig: { bridgeState?: MigrationBridgeState | null },
  now: Date,
): MigrationBridgeView | null {
  const b = mig.bridgeState;
  if (!b) return null;

  const ttl = b.recordTtlSeconds ?? null;
  const closableAt =
    b.state === 'active' && b.dnsFlippedAt
      ? new Date(
          new Date(b.dnsFlippedAt).getTime() +
            2 * (ttl ?? DEFAULT_RECORD_TTL_SECONDS) * 1000,
        ).toISOString()
      : null;
  let blockedBy: MigrationBridgeView['blockedBy'] = null;
  if (b.state === 'active') {
    if (!closableAt) blockedBy = 'dns';
    else if (now.getTime() < new Date(closableAt).getTime()) blockedBy = 'ttl';
  }
  const readyToClose = b.state === 'active' && blockedBy === null;
  const ageSeconds =
    b.state === 'active' && b.activatedAt
      ? Math.max(
          0,
          Math.round(
            (now.getTime() - new Date(b.activatedAt).getTime()) / 1000,
          ),
        )
      : null;

  return {
    mode: b.mode,
    skipReason: b.skipReason ?? null,
    state: b.state ?? null,
    hosts: (b.hosts ?? []).map((h) => ({
      fqdn: h.fqdn,
      certificate: h.certificate,
      certificateReady: h.certificateReady,
      ...(h.certificateNote ? { certificateNote: h.certificateNote } : {}),
    })),
    activatedAt: b.activatedAt ?? null,
    dnsFlippedAt: b.dnsFlippedAt ?? null,
    closedAt: b.closedAt ?? null,
    recordTtlSeconds: ttl,
    ageSeconds,
    closableAt,
    readyToClose,
    blockedBy,
    leftover: b.leftover ?? null,
    summary: withCertificateNotes(b, summarize(b, blockedBy, closableAt)),
  };
}

/** Why a name's certificate came from where it did, while the bridge is in use. */
function withCertificateNotes(
  b: MigrationBridgeState,
  summary: string,
): string {
  if (
    b.mode !== 'bridge' ||
    (b.state !== 'preparing' && b.state !== 'active')
  ) {
    return summary;
  }
  const notes = (b.hosts ?? [])
    .map((h) => h.certificateNote)
    .filter((n): n is string => !!n);
  return notes.length ? `${summary} ${notes.join(' ')}` : summary;
}

function summarize(
  b: MigrationBridgeState,
  blockedBy: MigrationBridgeView['blockedBy'],
  closableAt: string | null,
): string {
  if (b.mode === 'dns-only') {
    return `No bridge: ${b.skipReason ?? 'only DNS moves.'}`;
  }
  switch (b.state) {
    case 'active':
      if (blockedBy === 'dns') {
        return 'The old cluster forwards to the new one; the DNS switch has not completed.';
      }
      return blockedBy === 'ttl'
        ? `The old cluster forwards to the new one; safe to close from ${closableAt}.`
        : 'The old cluster forwards to the new one; cached DNS answers have expired, it can be closed.';
    case 'closed':
      return b.leftover ? `Bridge closed. ${b.leftover}` : 'Bridge closed.';
    case 'preparing': {
      const waiting = (b.hosts ?? []).filter(
        (h) => h.certificateRequired && !h.certificateReady,
      );
      return waiting.length
        ? `Bridge prepared; waiting for a valid certificate on the new cluster for ${waiting
            .map((h) => h.fqdn)
            .join(', ')}.`
        : 'Bridge prepared: at cutover the old cluster forwards to the new one.';
    }
    default:
      return 'At cutover the old cluster will forward to the new one.';
  }
}
