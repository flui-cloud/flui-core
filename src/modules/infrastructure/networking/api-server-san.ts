/**
 * Adding an address to a running API server's certificate.
 *
 * A cluster installed before the overlay existed has no management address in
 * `serving-kube-apiserver.crt`, so the control cluster can reach it through the
 * tunnel and still be refused at the TLS handshake. K3s only regenerates that
 * certificate when it is missing, so this is the one operation that restarts
 * K3s on a live master — hence a tracked operation with a rollback rather than
 * a command someone types.
 *
 * A drop-in under `config.yaml.d` adds the SAN and leaves the flags the
 * installer put in the systemd unit intact, so the addresses the cluster
 * already answered on keep working.
 */

export const SAN_PRESENT_MARKER = 'FLUI_SAN_PRESENT';
export const SAN_APPLIED_MARKER = 'FLUI_SAN_APPLIED';
export const SAN_UNSUPPORTED_MARKER = 'FLUI_SAN_UNSUPPORTED';
export const SAN_ROLLED_BACK_MARKER = 'FLUI_SAN_ROLLED_BACK';

const CERT = '/var/lib/rancher/k3s/server/tls/serving-kube-apiserver.crt';
const KEY = '/var/lib/rancher/k3s/server/tls/serving-kube-apiserver.key';

/** The operator's own `config.yaml` is left alone: merging a YAML list in
 *  shell into a file somebody else owns is how a master ends up not starting. */
const DROPIN_DIR = '/etc/rancher/k3s/config.yaml.d';
const DROPIN = `${DROPIN_DIR}/10-flui-tls-san.yaml`;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Rejects anything that is not a plain IPv4 address before it reaches a shell
 *  command line — this string is interpolated into a script that runs as root. */
export function isPlainIpv4(value: string): boolean {
  const m = IPV4.exec(value.trim());
  return !!m && [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255);
}

export function buildSanEnrolmentScript(
  address: string,
  opts: { waitSeconds?: number } = {},
): string {
  if (!isPlainIpv4(address)) {
    throw new Error(`Not an IPv4 address: "${address}"`);
  }
  // A dot matches anything in a regex, and these addresses are compared against
  // a certificate to decide whether to restart a live master.
  const escaped = address.replace(/\./g, '\\.');
  const attempts = Math.ceil((opts.waitSeconds ?? 300) / 5);

  return [
    'set -e',
    `if ! command -v k3s >/dev/null 2>&1 || [ ! -f ${CERT} ]; then echo ${SAN_UNSUPPORTED_MARKER}; exit 0; fi`,
    // Idempotent: the common case on a re-run, and the case where a cluster was
    // installed after the overlay existed and already carries the address.
    `if openssl x509 -in ${CERT} -noout -ext subjectAltName 2>/dev/null | grep -qE "IP Address:${escaped}([^0-9.]|$)"; then`,
    `  echo ${SAN_PRESENT_MARKER}`,
    '  exit 0',
    'fi',
    `mkdir -p ${DROPIN_DIR}`,
    `printf '# Flui-managed. The overlay address the control cluster reaches this API on.\\ntls-san:\\n  - %s\\n' '${address}' > ${DROPIN}.new`,
    `mv ${DROPIN}.new ${DROPIN}`,
    // Kept, not just deleted: if K3s comes back unhappy for a reason that has
    // nothing to do with the SAN, the cluster's own certificate is still here.
    `cp ${CERT} ${CERT}.flui-backup`,
    `cp ${KEY} ${KEY}.flui-backup`,
    `rm -f ${CERT} ${KEY}`,
    // Not left to `set -e`: a restart that fails outright is exactly what the
    // rollback below exists for, and aborting here would leave the master with
    // no certificate and a drop-in nobody removed.
    'systemctl restart k3s >/dev/null 2>&1 || true',
    // Three conditions, not one: a readiness probe alone says only that *an*
    // API is answering, and a process still in memory answers happily with the
    // old certificate. The certificate must be back on disk, carry the new
    // address, and the API be ready — all three, or the rollback below runs.
    `i=0; while [ $i -lt ${attempts} ]; do`,
    `  if [ -f ${CERT} ] &&`,
    `     openssl x509 -in ${CERT} -noout -ext subjectAltName 2>/dev/null | grep -qE "IP Address:${escaped}([^0-9.]|$)" &&`,
    '     k3s kubectl get --raw /readyz >/dev/null 2>&1; then',
    `    echo ${SAN_APPLIED_MARKER}`,
    '    exit 0',
    '  fi',
    '  i=$((i + 1)); sleep 5',
    'done',
    // Never leave a master that will not come up. The drop-in goes, the old
    // certificate comes back, and K3s restarts onto exactly what it had.
    `rm -f ${DROPIN}`,
    `cp ${CERT}.flui-backup ${CERT} 2>/dev/null || true`,
    `cp ${KEY}.flui-backup ${KEY} 2>/dev/null || true`,
    'systemctl restart k3s >/dev/null 2>&1 || true',
    `echo ${SAN_ROLLED_BACK_MARKER}`,
    // Zero, even though this is the failure. The transport rejects a non-zero
    // exit with stderr alone, and the marker — the only thing that says what
    // happened and whether the master was restored — is on stdout. The caller
    // raises the error from the marker; losing it to an exit code would turn a
    // clean rollback into "SSH exec failed (code 1)".
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Reads the addresses a live API server's certificate actually covers.
 *
 * The database records what Flui asked for; only the certificate says what the
 * TLS handshake will accept.
 */
export function buildSanReadScript(): string {
  return [
    `if [ ! -f ${CERT} ]; then echo ${SAN_UNSUPPORTED_MARKER}; exit 0; fi`,
    `openssl x509 -in ${CERT} -noout -ext subjectAltName 2>/dev/null || true`,
    '',
  ].join('\n');
}

export function parseCertificateIps(output: string): string[] {
  const found = new Set<string>();
  for (const m of output.matchAll(/IP Address:([0-9A-Fa-f.:]+)/g)) {
    found.add(m[1]);
  }
  return [...found];
}
