import {
  PRIVATE_KEY_PLACEHOLDER,
  WG_INTERFACE,
  isWireGuardPublicKey,
} from './wireguard-config';

export const KEY_MARKER = 'FLUI_WG_PUBKEY';
export const READY_MARKER = 'FLUI_WG_READY';
export const APPLIED_MARKER = 'FLUI_WG_APPLIED';
export const UNSUPPORTED_MARKER = 'FLUI_WG_UNSUPPORTED';

const KEY_DIR = '/etc/wireguard';
const INSTALL_LOG = '/var/log/flui-wg-install.log';

/**
 * Installs WireGuard if needed and makes sure the node owns a keypair, then
 * prints the public half.
 *
 * Idempotent: run twice and the second run reuses the existing key, because
 * regenerating it would silently orphan every peer entry that names the old
 * one. The private key is created here, on the node, with a restrictive umask,
 * and never leaves — Flui only ever learns the public half, from this output.
 */
export function buildKeyEnrolmentScript(iface: string = WG_INTERFACE): string {
  const key = `${KEY_DIR}/${iface}.key`;
  const pub = `${KEY_DIR}/${iface}.pub`;
  return [
    'set -e',
    `LOG=${INSTALL_LOG}`,
    'if ! command -v wg >/dev/null 2>&1; then',
    '  export DEBIAN_FRONTEND=noninteractive',
    // A node minutes out of provisioning is still running its own apt —
    // cloud-init, unattended-upgrades — and holds the dpkg lock. Wait for it
    // rather than mistaking "busy" for "cannot run WireGuard".
    '  i=0',
    '  while [ $i -lt 24 ]; do',
    '    if apt-get install -y -qq wireguard-tools >"$LOG" 2>&1; then break; fi',
    // -E on purpose: without it the alternation is matched literally, the
    // branch never fires, and the wait silently does nothing.
    '    if grep -qiE "could not get lock|unable to lock|dpkg frontend" "$LOG"; then',
    '      i=$((i+1)); sleep 5; continue',
    '    fi',
    '    apt-get update -qq >>"$LOG" 2>&1 || true',
    '    apt-get install -y -qq wireguard-tools >>"$LOG" 2>&1 || true',
    '    break',
    '  done',
    'fi',
    // Only now is "unsupported" an honest verdict — and it carries the reason,
    // because a silent one sends whoever reads it after the wrong thing.
    'if ! command -v wg >/dev/null 2>&1; then',
    `  echo ${UNSUPPORTED_MARKER}`,
    '  echo "reason: $(tail -2 "$LOG" 2>/dev/null | tr \'\\n\' \' \')"',
    '  exit 0',
    'fi',
    `mkdir -p ${KEY_DIR}`,
    `chmod 700 ${KEY_DIR}`,
    `if [ ! -s ${key} ]; then`,
    '  ( umask 077; wg genkey > ' + key + ' )',
    `  wg pubkey < ${key} > ${pub}`,
    'fi',
    `if [ ! -s ${pub} ]; then wg pubkey < ${key} > ${pub}; fi`,
    `chmod 600 ${key}`,
    `echo ${KEY_MARKER}=$(cat ${pub})`,
    `echo ${READY_MARKER}`,
    // Trailing newline: piped into a shell, a script without one runs its last
    // line into whatever follows — seen live as `FLUI_WG_READYecho ...`.
    '',
  ].join('\n');
}

/**
 * Writes the rendered config, substitutes the node's own private key into it,
 * and brings the interface up.
 *
 * The config arrives base64-encoded so no quoting in it can break the shell,
 * and the private key is spliced in on the node: what travels over the wire and
 * what Flui stores never contains it.
 *
 * `wg syncconf` rather than a down/up cycle — it applies the delta without
 * tearing down established sessions, so reconciling one node's peer list does
 * not interrupt the tunnels of the others.
 */
export function buildApplyScript(
  renderedConfig: string,
  iface: string = WG_INTERFACE,
): string {
  const b64 = Buffer.from(renderedConfig, 'utf-8').toString('base64');
  const key = `${KEY_DIR}/${iface}.key`;
  const conf = `${KEY_DIR}/${iface}.conf`;
  return [
    'set -e',
    `if ! command -v wg >/dev/null 2>&1; then echo ${UNSUPPORTED_MARKER}; exit 0; fi`,
    `if [ ! -s ${key} ]; then echo "missing private key at ${key}" >&2; exit 3; fi`,
    `mkdir -p ${KEY_DIR}`,
    `echo '${b64}' | base64 -d > ${conf}.new`,
    `sed -i "s|${PRIVATE_KEY_PLACEHOLDER}|$(cat ${key})|" ${conf}.new`,
    `chmod 600 ${conf}.new`,
    `mv ${conf}.new ${conf}`,
    // `wg syncconf` applies peers and keys but NOT the interface address: a
    // node whose address changes would keep answering on the old one while the
    // rest of the fleet routes to the new. Compare first, and take the
    // interface down when it moved — the only case worth the interruption.
    `WANT_ADDR=$(grep -E '^Address' ${conf} | head -1 | sed 's/.*= *//;s#/.*##')`,
    `HAVE_ADDR=$(ip -4 -brief addr show ${iface} 2>/dev/null | awk '{print $3}' | sed 's#/.*##')`,
    `if [ -n "$HAVE_ADDR" ] && [ "$HAVE_ADDR" != "$WANT_ADDR" ]; then`,
    `  wg-quick down ${conf} >/dev/null 2>&1 || true`,
    'fi',
    `if ip link show ${iface} >/dev/null 2>&1; then`,
    // No process substitution: this runs under whatever /bin/sh the image ships,
    // and on Ubuntu that is dash, where `<(...)` is a syntax error.
    `  ( umask 077; wg-quick strip ${conf} > ${conf}.stripped )`,
    `  wg syncconf ${iface} ${conf}.stripped`,
    `  rm -f ${conf}.stripped`,
    'else',
    `  wg-quick up ${conf}`,
    'fi',
    `systemctl enable wg-quick@${iface} >/dev/null 2>&1 || true`,
    `echo ${APPLIED_MARKER}`,
    '',
  ].join('\n');
}

export interface WireGuardPeerState {
  publicKey: string;
  endpoint?: string;
  allowedIps: string[];
  latestHandshakeAt?: Date;
  transferRx: number;
  transferTx: number;
}

export interface WireGuardInterfaceState {
  interface: string;
  publicKey?: string;
  listenPort?: number;
  peers: WireGuardPeerState[];
}

/**
 * Parses `wg show <iface> dump`.
 *
 * The dump format is tab-separated and stable across versions, unlike the
 * human-readable output: first line is the interface (private key, public key,
 * listen port, fwmark), every line after is a peer (public key, preshared key,
 * endpoint, allowed ips, latest handshake, rx, tx, keepalive).
 *
 * The interface line's first field is the *private* key. It is read past and
 * never returned — a health check has no business carrying it, and a caller
 * that cannot see it cannot log it by accident.
 */
export function parseWireGuardDump(
  dump: string,
  iface: string = WG_INTERFACE,
): WireGuardInterfaceState {
  const lines = dump
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.includes('\t'));
  const state: WireGuardInterfaceState = { interface: iface, peers: [] };
  if (lines.length === 0) return state;

  const [, publicKey, listenPort] = lines[0].split('\t');
  if (publicKey && isWireGuardPublicKey(publicKey)) state.publicKey = publicKey;
  const port = Number(listenPort);
  if (Number.isInteger(port) && port > 0) state.listenPort = port;

  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    const handshake = Number(f[4]);
    state.peers.push({
      publicKey: f[0],
      endpoint: f[2] && f[2] !== '(none)' ? f[2] : undefined,
      allowedIps:
        f[3] && f[3] !== '(none)' ? f[3].split(',').map((s) => s.trim()) : [],
      // 0 means "never", not "the epoch" — a peer that has never completed a
      // handshake must not read as one that shook hands in 1970.
      latestHandshakeAt:
        Number.isInteger(handshake) && handshake > 0
          ? new Date(handshake * 1000)
          : undefined,
      transferRx: Number(f[5]) || 0,
      transferTx: Number(f[6]) || 0,
    });
  }
  return state;
}

/** A peer is healthy while its last handshake is recent. WireGuard rehandshakes
 *  about every two minutes when traffic flows, so three minutes of silence is
 *  the first credible sign of a broken path rather than an idle one. */
export const HANDSHAKE_STALE_AFTER_MS = 3 * 60 * 1000;

export function isHandshakeFresh(
  peer: WireGuardPeerState,
  now: Date = new Date(),
): boolean {
  if (!peer.latestHandshakeAt) return false;
  return (
    now.getTime() - peer.latestHandshakeAt.getTime() < HANDSHAKE_STALE_AFTER_MS
  );
}

export function extractPublicKey(output: string): string | undefined {
  const line = output
    .split('\n')
    .find((l) => l.trim().startsWith(`${KEY_MARKER}=`));
  if (!line) return undefined;
  const value = line
    .trim()
    .slice(KEY_MARKER.length + 1)
    .trim();
  return isWireGuardPublicKey(value) ? value : undefined;
}
