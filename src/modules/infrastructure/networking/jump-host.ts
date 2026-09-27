/**
 * The control master as the one way in to workload nodes: a user that can
 * forward to the Flui network's addresses on port 22 and do nothing else.
 *
 * Written as a drop-in, never into sshd_config itself, and only kept when two
 * things hold: sshd accepts the file, and root's effective configuration is
 * exactly what it was before. A Match block that leaked past its file would
 * change how everyone else logs in; the second check is what makes that
 * impossible to ship.
 */
export const JUMP_USER = 'flui-jump';
export const JUMP_APPLIED_MARKER = 'FLUI_JUMP_APPLIED';
export const JUMP_UNCHANGED_MARKER = 'FLUI_JUMP_UNCHANGED';
export const JUMP_REFUSED_MARKER = 'FLUI_JUMP_REFUSED';

const DROP_IN = '/etc/ssh/sshd_config.d/60-flui-jump.conf';
const PRINCIPALS_DIR = '/etc/ssh/flui-principals';
const SSHD_CONFIG = '/etc/ssh/sshd_config';
const ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$/;

export function renderJumpConfig(memberAddresses: string[]): string {
  const addresses = [...new Set(memberAddresses)]
    .filter((a) => ADDRESS.test(a))
    .sort((a, b) => a.localeCompare(b));
  const permit = addresses.length
    ? addresses.map((a) => `${a}:22`).join(' ')
    : 'none';
  return [
    `Match User ${JUMP_USER}`,
    `  AuthorizedPrincipalsFile ${PRINCIPALS_DIR}/%u`,
    '  AllowTcpForwarding local',
    `  PermitOpen ${permit}`,
    '  PermitTTY no',
    '  X11Forwarding no',
    '  AllowAgentForwarding no',
    '  AllowStreamLocalForwarding no',
    '  GatewayPorts no',
    '  PermitTunnel no',
    '  ForceCommand /usr/sbin/nologin',
    '',
  ].join('\n');
}

/** `root` prefixes every path, so the script can be run against a scratch tree. */
export function buildJumpHostScript(
  memberAddresses: string[],
  root = '',
): string {
  const DROP_IN_PATH = `${root}${DROP_IN}`;
  const PRINCIPALS = `${root}${PRINCIPALS_DIR}`;
  const config = Buffer.from(
    renderJumpConfig(memberAddresses),
    'utf-8',
  ).toString('base64');
  const probe = 'user=root,host=flui-probe,addr=127.0.0.1';
  return [
    'set -e',
    `if ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/' ${root}${SSHD_CONFIG}; then`,
    `  echo "${JUMP_REFUSED_MARKER} sshd_config does not include sshd_config.d"`,
    '  exit 0',
    'fi',
    `id ${JUMP_USER} >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin ${JUMP_USER}`,
    `mkdir -p ${PRINCIPALS}`,
    `echo ${JUMP_USER} > ${PRINCIPALS}/${JUMP_USER}`,
    `chmod 644 ${PRINCIPALS}/${JUMP_USER}`,
    `echo '${config}' | base64 -d > ${DROP_IN_PATH}.new`,
    `if [ -f ${DROP_IN_PATH} ] && cmp -s ${DROP_IN_PATH}.new ${DROP_IN_PATH}; then`,
    `  rm -f ${DROP_IN_PATH}.new`,
    `  echo ${JUMP_UNCHANGED_MARKER}`,
    '  exit 0',
    'fi',
    `BEFORE=$(sshd -T -C ${probe} 2>/dev/null | sort)`,
    'if [ -z "$BEFORE" ]; then',
    `  rm -f ${DROP_IN_PATH}.new`,
    `  echo "${JUMP_REFUSED_MARKER} root's sshd configuration cannot be read, so the change cannot be checked"`,
    '  exit 0',
    'fi',
    `[ -f ${DROP_IN_PATH} ] && cp ${DROP_IN_PATH} ${DROP_IN_PATH}.old || rm -f ${DROP_IN_PATH}.old`,
    `mv ${DROP_IN_PATH}.new ${DROP_IN_PATH}`,
    `chmod 644 ${DROP_IN_PATH}`,
    `AFTER=$(sshd -T -C ${probe} 2>/dev/null | sort || true)`,
    `if ! sshd -t 2>/dev/null || [ "$BEFORE" != "$AFTER" ]; then`,
    `  if [ -f ${DROP_IN_PATH}.old ]; then mv ${DROP_IN_PATH}.old ${DROP_IN_PATH}; else rm -f ${DROP_IN_PATH}; fi`,
    `  echo "${JUMP_REFUSED_MARKER} the drop-in would change how root logs in, or sshd rejects it"`,
    '  exit 0',
    'fi',
    `rm -f ${DROP_IN_PATH}.old`,
    'systemctl reload ssh 2>/dev/null || systemctl reload sshd',
    `echo ${JUMP_APPLIED_MARKER}`,
    '',
  ].join('\n');
}
