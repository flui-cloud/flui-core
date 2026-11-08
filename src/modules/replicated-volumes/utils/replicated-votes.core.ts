/**
 * Installs the kernel headers the volume engine builds its module from, and
 * the package that follows the kernel's flavour (`linux-headers-generic`), so
 * the next kernel an upgrade boots into comes with its headers too.
 */
export const HEADERS_INSTALL = [
  'KFLAVOUR="linux-headers-${KREL##*-}"',
  'if [ ! -d "/lib/modules/$KREL/build" ] || ! dpkg -s "$KFLAVOUR" >/dev/null 2>&1; then',
  '  apt-get update -qq >/dev/null 2>&1 || true',
  '  [ -d "/lib/modules/$KREL/build" ] || apt-get install -y -qq "linux-headers-$KREL" >/dev/null 2>&1 || true',
  '  apt-get install -y -qq "$KFLAVOUR" >/dev/null 2>&1 || true',
  'fi',
];

/**
 * Prepares a node that only votes: it holds no data, but the volume engine
 * still loads its module there to count as the tie-breaker, and builds it from
 * the kernel headers. Without them the vote never joins and a lost copy leaves
 * the other one without a majority.
 */
export function replicatedVoteHostScript(): string {
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'KREL=$(uname -r)',
    ...HEADERS_INSTALL,
    'if [ ! -d "/lib/modules/$KREL/build" ]; then echo "NOHEADERS $KREL"; exit 0; fi',
    'echo "HEADERS $KREL"',
  ].join('\n');
}

/**
 * The tie-breakers the volume engine does not count. A node missing from its
 * list, or not online there, never casts the deciding vote, so losing a copy
 * leaves the other one without a majority and the application where it was.
 * Unreadable output says nothing.
 */
export function missingVoteWarnings(
  tieBreakers: string[],
  linstorNodesJson: string,
): string[] {
  let nodes: Array<{ name?: string; connection_status?: string }>;
  try {
    const parsed = JSON.parse(linstorNodesJson) as unknown[];
    nodes = (Array.isArray(parsed[0]) ? parsed[0] : parsed) as typeof nodes;
    if (!Array.isArray(nodes)) return [];
  } catch {
    return [];
  }
  return tieBreakers
    .filter((name) => {
      const node = nodes.find((n) => n.name === name);
      return !node || (node.connection_status ?? 'ONLINE') !== 'ONLINE';
    })
    .map(
      (name) =>
        `${name} does not hold the tie-breaking vote yet: the volume engine is not running there, so losing a location with a copy leaves the other copy without a majority and applications stay where they are.`,
    );
}
