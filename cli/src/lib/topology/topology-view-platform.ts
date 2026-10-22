import chalk from 'chalk';
import type { TopologyAppDto } from '../../../../src/modules/topology/dto/topology.dto';
import {
  isSystem,
  isTroubled,
  trafficIn,
  worstAppStatus,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import {
  cpu,
  memory,
  plural,
  row,
  rpsValue,
  statusLabel,
  toneOf,
} from './topology-format';
import {
  APP_COLUMNS,
  APP_HEADER,
  appEntry,
  byStackThenName,
  replicasOf,
} from './topology-view-shared';
import type {
  Snapshot,
  TopologyEntry,
  TopologyView,
} from './topology-view-types';

export function platformEntry(
  t: Snapshot,
  clusterId: string,
  own: TopologyAppDto[],
): TopologyEntry {
  const status = worstAppStatus(own);
  const traffic = own
    .map((a) => trafficIn(t, a.id))
    .filter((v): v is number => v !== null);
  const troubled = own.filter(isTroubled);
  return {
    key: `platform:${clusterId}`,
    target: { type: 'platform', id: clusterId },
    line: row(APP_COLUMNS, [
      `Flui platform (${own.length})`,
      { text: 'Infrastructure', paint: chalk.dim },
      String(replicasOf(own)),
      { text: statusLabel(status), paint: toneOf(status) },
      traffic.length
        ? rpsValue(traffic.reduce((s, v) => s + v, 0))
        : { text: '—', paint: chalk.dim },
      '',
    ]),
    note: troubled.length
      ? troubled
          .map(
            (a) =>
              `${a.displayName}: ${a.statusReason ?? statusLabel(a.status)}`,
          )
          .join(' · ')
      : undefined,
    notePaint: toneOf(status),
  };
}

export function platformView(
  t: Snapshot,
  clusterId: string,
): TopologyView | null {
  const c = t.clusters.find((x) => x.id === clusterId);
  const own = t.apps.filter((a) => a.clusterId === clusterId && isSystem(a));
  if (!c || !own.length) return null;
  const status = worstAppStatus(own);
  return {
    trail: ['Fleet', c.name, 'Flui platform'],
    summary: [
      `${chalk.bold('Flui platform')}  what Flui runs for itself on ${c.name}  ${toneOf(status)(statusLabel(status))}`,
      [
        plural(own.length, 'app'),
        plural(replicasOf(own), 'replica'),
        `${memory(own.reduce((n, a) => n + a.ramRequestMB * a.replicaCount, 0))} memory requested`,
        `${cpu(own.reduce((n, a) => n + a.cpuRequestM * a.replicaCount, 0))} CPU requested`,
      ].join(' · '),
    ],
    sections: [
      {
        title: 'Apps',
        header: APP_HEADER,
        entries: [...own].sort(byStackThenName(t)).map((a) => appEntry(t, a)),
      },
    ],
  };
}
