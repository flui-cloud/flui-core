/**
 * What a cluster across three locations needs before one of its nodes is
 * switched off to change its size. A resize is a planned loss of that node,
 * which the cluster survives only while everything else stands.
 */
export function resizeHaRefusal(input: {
  clusterName: string;
  nodeName: string;
  serversNotReady: string[];
  otherResizeRunning: string | null;
  staleCopies: string[];
}): string | null {
  if (input.otherResizeRunning) {
    return `${input.otherResizeRunning} of ${input.clusterName} is being resized: in a cluster across three locations one node is switched off at a time.`;
  }
  const others = input.serversNotReady.filter((s) => s !== input.nodeName);
  if (others.length) {
    return `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} not ready: switching off ${input.nodeName} now would leave the cluster without the majority it needs to keep running.`;
  }
  if (input.staleCopies.length) {
    return `${input.staleCopies[0]} Resize ${input.nodeName} once every copy is up to date.`;
  }
  return null;
}

export interface CnpgInstance {
  name: string;
  node?: string;
  ready: boolean;
}

/**
 * A primary that would go down with the node is handed over first: a planned
 * switchover pauses writes for seconds, the failover that would follow the
 * node otherwise takes about a minute. The copy that takes over is a ready one
 * on another node, in a location for data when there is one.
 */
export function switchoverTarget(input: {
  primary: string | undefined;
  nodeName: string;
  instances: CnpgInstance[];
  zoneOf: Map<string, string>;
  preferredZones: string[];
}): string | null {
  const primary = input.instances.find((i) => i.name === input.primary);
  if (primary?.node !== input.nodeName) return null;
  const candidates = input.instances
    .filter((i) => i.ready && i.node && i.node !== input.nodeName)
    .sort(
      (a, b) =>
        Number(input.preferredZones.includes(input.zoneOf.get(b.node!) ?? '')) -
          Number(
            input.preferredZones.includes(input.zoneOf.get(a.node!) ?? ''),
          ) || a.name.localeCompare(b.name),
    );
  return candidates[0]?.name ?? null;
}

/**
 * Grows the space for copies on a node whose disk grew: the file is allocated
 * to the new size, the loop device rereads it and the volume group takes the
 * new space. Never shrinks.
 */
export function growCopiesScript(
  file: string,
  volumeGroup: string,
  sizeGiB: number,
): string {
  if (!Number.isInteger(sizeGiB) || sizeGiB < 1) {
    throw new Error(`invalid size ${sizeGiB}`);
  }
  return [
    'set -e',
    `FILE=${file}`,
    '[ -f "$FILE" ] || { echo "NOPOOL"; exit 0; }',
    'NOW=$(stat -c %s "$FILE")',
    `WANT=$(( ${sizeGiB} * 1024 * 1024 * 1024 ))`,
    '[ "$WANT" -gt "$NOW" ] || { echo "UNCHANGED $NOW"; exit 0; }',
    'FREE=$(df -B1 --output=avail "$(dirname "$FILE")" | tail -1 | tr -d " ")',
    '[ $(( WANT - NOW + 5 * 1024 * 1024 * 1024 )) -le "$FREE" ] || { echo "NOSPACE $FREE"; exit 0; }',
    'fallocate -l "$WANT" "$FILE"',
    'DEV=$(losetup -j "$FILE" -O NAME -n | head -1)',
    'losetup -c "$DEV"',
    'pvresize -q "$DEV"',
    `echo "GROWN $(vgs --noheadings --units g --nosuffix -o vg_size ${volumeGroup} | tr -d ' ')"`,
  ].join('\n');
}
