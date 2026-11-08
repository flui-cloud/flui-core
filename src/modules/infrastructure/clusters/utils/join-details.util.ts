export interface JoinDetails {
  masterIp: string;
  k3sToken: string;
  sharedStorageMasterIp?: string | null;
}

export const JOIN_DETAILS_HANDED_OVER = 'join-details-handed-over';
export const JOIN_DETAILS_ALREADY_JOINED = 'join-details-already-joined';

const QUOTED_QUOTE = String.raw`'\''`;

function quoted(value: string): string {
  return "'" + value.replaceAll("'", QUOTED_QUOTE) + "'";
}

/**
 * The shell that hands a waiting server where to join. The file appears whole,
 * so the boot script never reads half of it, and a server that already joined
 * gets nothing, because the boot script deletes the file once it has read it
 * and a second copy would leave the token on its disk.
 */
export function joinDetailsScript(details: JoinDetails): string {
  const lines = [
    `K3S_URL=${quoted('https://' + details.masterIp + ':6443')}`,
    `K3S_TOKEN=${quoted(details.k3sToken)}`,
    `MASTER_IP=${quoted(details.masterIp)}`,
    ...(details.sharedStorageMasterIp
      ? [
          `FLUI_SHARED_STORAGE_MASTER_IP=${quoted(details.sharedStorageMasterIp)}`,
        ]
      : []),
  ];
  return [
    'set -e',
    'umask 077',
    'mkdir -p /var/lib/flui',
    `if [ -e /etc/systemd/system/k3s.service ]; then echo ${JOIN_DETAILS_ALREADY_JOINED}; exit 0; fi`,
    "cat > /var/lib/flui/k3s-join.env.tmp <<'FLUI_JOIN_DETAILS'",
    ...lines,
    'FLUI_JOIN_DETAILS',
    'mv /var/lib/flui/k3s-join.env.tmp /var/lib/flui/k3s-join.env',
    `echo ${JOIN_DETAILS_HANDED_OVER}`,
  ].join('\n');
}
