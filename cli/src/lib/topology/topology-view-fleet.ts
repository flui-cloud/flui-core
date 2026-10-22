import chalk from 'chalk';
import {
  TopologyAttention,
  attentionOf,
  clusterNameOf,
  isTroubled,
  spreadOf,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import {
  Column,
  Paint,
  plural,
  row,
  statusLabel,
  toneOf,
} from './topology-format';
import { replicasOf, userApps } from './topology-view-shared';
import type {
  Snapshot,
  TopologyEntry,
  TopologySection,
  TopologyView,
} from './topology-view-types';

const dot = (paint: Paint) => paint('●');

const CLUSTER_COLUMNS: Column[] = [
  { width: 18 },
  { width: 22 },
  { width: 7, align: 'right' },
  { width: 5, align: 'right' },
  { width: 8, align: 'right' },
  { width: 9 },
];

export function fleetView(t: Snapshot): TopologyView {
  const apps = userApps(t.apps);
  const platform = t.apps.length - apps.length;
  const summary = [
    [
      plural(t.clusters.length, 'cluster'),
      plural(t.servers.length, 'server'),
      plural(apps.length, 'app'),
      plural(replicasOf(apps), 'replica'),
      ...(platform ? [`${platform} platform apps`] : []),
    ].join(' · '),
  ];
  const clusters: TopologyEntry[] = t.clusters.map((c) => {
    const own = t.apps.filter((a) => a.clusterId === c.id);
    const problems = own.filter(isTroubled).length;
    return {
      key: `cluster:${c.id}`,
      target: { type: 'cluster', id: c.id },
      line: row(CLUSTER_COLUMNS, [
        { text: c.name, paint: chalk.bold },
        `${c.provider} · ${c.region}`,
        String(t.servers.filter((s) => s.clusterId === c.id).length),
        String(userApps(own).length),
        problems
          ? { text: String(problems), paint: chalk.yellow }
          : { text: '—', paint: chalk.dim },
        { text: statusLabel(c.status), paint: toneOf(c.status) },
      ]),
    };
  });
  return {
    trail: ['Fleet'],
    summary,
    sections: [
      {
        title: 'Clusters',
        header: row(CLUSTER_COLUMNS, [
          'CLUSTER',
          'WHERE',
          'SERVERS',
          'APPS',
          'PROBLEMS',
          'STATUS',
        ]),
        entries: clusters,
      },
      attentionSection(t),
      ...spreadSection(t),
    ],
  };
}

const ATTENTION_COLUMNS: Column[] = [
  { width: 16 },
  { width: 12 },
  { width: 46 },
];

function clusterOf(t: Snapshot, item: TopologyAttention): string | null {
  if (item.type === 'cluster') return null;
  return (item.type === 'app' ? t.apps : t.servers).find(
    (x: { id: string }) => x.id === item.id,
  )?.clusterId;
}

function attentionSection(t: Snapshot): TopologySection {
  const items = attentionOf(t);
  if (!items.length)
    return {
      title: 'Needs attention',
      lines: [chalk.dim('Nothing right now.')],
    };
  return {
    title: 'Needs attention',
    entries: items.map((item) => {
      const paint = item.severity === 'error' ? chalk.red : chalk.yellow;
      const clusterId = clusterOf(t, item);
      const fits = item.detail.length <= ATTENTION_COLUMNS[2].width;
      return {
        key: `attention:${item.type}:${item.id}`,
        target: { type: item.type, id: item.id },
        line: `${dot(paint)} ${row(
          ATTENTION_COLUMNS,
          [
            item.label,
            {
              text: clusterId ? clusterNameOf(t, clusterId) : '',
              paint: chalk.dim,
            },
            { text: fits ? item.detail : '', paint },
          ],
          1,
        )}`,
        ...(fits ? {} : { note: item.detail, notePaint: paint }),
      };
    }),
  };
}

function spreadSection(t: Snapshot): TopologySection[] {
  const spread = spreadOf(t);
  if (!spread.length) return [];
  return [
    {
      title: 'Spread across clusters',
      entries: spread.map((s) => ({
        key: `spread:${s.appId}`,
        target: { type: 'app', id: s.appId },
        line: row(
          [{ width: 20 }, { width: 54 }],
          [s.label, { text: s.clusters.join(' · '), paint: chalk.dim }],
        ),
      })),
    },
  ];
}
