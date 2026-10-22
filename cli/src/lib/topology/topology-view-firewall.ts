import type { TopologyInboundRuleDto } from '../../../../src/modules/topology/dto/topology.dto';
import { plural, truncate } from './topology-format';
import type { Snapshot } from './topology-view-types';

const INBOUND_WIDTH = 78;
const PORT_NAME: Record<string, string> = {
  '22': 'SSH',
  '80': 'HTTP',
  '443': 'HTTPS',
};

/** A rule's short name: the well-known one for its port, else its description up to the first aside. */
function ruleName(r: TopologyInboundRuleDto): string {
  if (r.protocol === 'tcp' && r.port && PORT_NAME[r.port])
    return PORT_NAME[r.port];
  const cut = [',', ' (', ' from ', ' for ']
    .map((mark) => r.description.indexOf(mark))
    .filter((i) => i > 0);
  return (
    cut.length ? r.description.slice(0, Math.min(...cut)) : r.description
  ).trim();
}

/** Items joined until the width runs out, then how many were left: never a cut word. */
function fitList(label: string, items: string[], width: number): string {
  for (let shown = items.length; shown > 0; shown--) {
    const rest = items.length - shown;
    const more = rest ? ` +${rest} more` : '';
    const line = `${label}${items.slice(0, shown).join(', ')}${more}`;
    if (line.length <= width) return line;
  }
  return truncate(`${label}${items.length} ports`, width);
}

/** What a cluster lets in: what anyone can reach, and what only some address ranges can. */
export function inboundLines(t: Snapshot, clusterId: string): string[] {
  const c = t.clusters.find((x) => x.id === clusterId);
  if (!c?.inbound) return [];
  if (!c.inbound.length) return ['Open to the Internet: nothing'];
  const what = (r: TopologyInboundRuleDto) => {
    const port = r.port ? `:${r.port}` : r.protocol.toUpperCase();
    const name = ruleName(r);
    return name ? `${port} ${name}` : port;
  };
  const open = c.inbound.filter((r) => r.fromAnywhere).map(what);
  const limited = c.inbound
    .filter((r) => !r.fromAnywhere)
    .map((r) => `${what(r)} (${plural(r.sourceCount, 'range')})`);
  const parts = [
    ...(open.length ? [['Public: ', open] as const] : []),
    ...(limited.length ? [['Limited: ', limited] as const] : []),
  ];
  const oneLine = parts
    .map(([label, items]) => `${label}${items.join(', ')}`)
    .join(' · ');
  if (oneLine.length <= INBOUND_WIDTH) return [oneLine];
  return parts.map(([label, items]) =>
    fitList(label.padEnd(9), [...items], INBOUND_WIDTH),
  );
}
