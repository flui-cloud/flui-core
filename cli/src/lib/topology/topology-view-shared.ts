import chalk from 'chalk';
import type { TopologyAppDto } from '../../../../src/modules/topology/dto/topology.dto';
import {
  isSystem,
  isTroubled,
  trafficIn,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import {
  Column,
  categoryLabel,
  row,
  rpsValue,
  statusLabel,
  toneOf,
} from './topology-format';
import type { Snapshot, TopologyEntry } from './topology-view-types';

export const userApps = (apps: TopologyAppDto[]) =>
  apps.filter((a) => !isSystem(a));
export const replicasOf = (apps: TopologyAppDto[]) =>
  apps.reduce((n, a) => n + a.replicaCount, 0);

export const APP_COLUMNS: Column[] = [
  { width: 20 },
  { width: 15 },
  { width: 8, align: 'right' },
  { width: 8 },
  { width: 7, align: 'right' },
  { width: 8 },
];

export const APP_HEADER = row(APP_COLUMNS, [
  'APP',
  'TYPE',
  'REPLICAS',
  'STATUS',
  'REQ/S',
  'EXPOSURE',
]);

export const noteOf = (a: TopologyAppDto) =>
  isTroubled(a) || a.statusReason ? (a.statusReason ?? undefined) : undefined;

export function appEntry(
  t: Snapshot,
  a: TopologyAppDto,
  keyPrefix = 'app',
): TopologyEntry {
  const traffic = trafficIn(t, a.id);
  return {
    key: `${keyPrefix}:${a.id}`,
    target: { type: 'app', id: a.id },
    line: row(APP_COLUMNS, [
      a.displayName,
      { text: categoryLabel(a.category), paint: chalk.dim },
      String(a.replicaCount),
      { text: statusLabel(a.status), paint: toneOf(a.status) },
      traffic === null ? { text: '—', paint: chalk.dim } : rpsValue(traffic),
      { text: a.exposure, paint: chalk.dim },
    ]),
    note: noteOf(a),
    notePaint: toneOf(a.status),
  };
}

/** Apps of a shared stack first, together, then the ones standing alone. */
export const byStackThenName =
  (t: Snapshot) => (a: TopologyAppDto, b: TopologyAppDto) => {
    const shared = (x: TopologyAppDto) => {
      const stack = t.stacks.find((s) => s.id === x.stackId);
      return stack && stack.appIds.length > 1 ? stack.name : null;
    };
    const [sa, sb] = [shared(a), shared(b)];
    if (!!sa !== !!sb) return sa ? -1 : 1;
    return (
      (sa ?? '').localeCompare(sb ?? '') ||
      a.displayName.localeCompare(b.displayName)
    );
  };

export const ROLE: Record<string, string> = {
  'control-plane': 'control plane',
  worker: 'worker',
};
export const ARCH: Record<string, string> = { arm: 'Arm', x86: 'x86' };
