import chalk from 'chalk';
import type { TopologyLinkDto } from '../../../../src/modules/topology/dto/topology.dto';
import {
  calleesOf,
  callersOf,
  clusterNameOf,
  isSystem,
  routesTo,
  trafficIn,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import {
  Column,
  categoryLabel,
  cpu,
  facts,
  memory,
  percent,
  row,
  rps,
  statusLabel,
  toneOf,
} from './topology-format';
import { ROLE, noteOf } from './topology-view-shared';
import type {
  Snapshot,
  TopologyEntry,
  TopologyView,
} from './topology-view-types';

function routeUrl(l: TopologyLinkDto): string {
  const path = l.routePath && l.routePath !== '/' ? l.routePath : '';
  return `https://${l.routeHost ?? '—'}${path}`;
}

const PEER_COLUMNS: Column[] = [
  { width: 24 },
  { width: 18 },
  { width: 8 },
  { width: 18 },
];

function crossingOf(l: TopologyLinkDto): string {
  if (!l.crossCluster) return '';
  return l.viaTunnel ? 'over the Flui network' : 'on a public address';
}

function peerEntry(
  t: Snapshot,
  l: TopologyLinkDto,
  peerId: string,
  key: string,
): TopologyEntry | null {
  const peer = t.apps.find((a) => a.id === peerId);
  if (!peer) return null;
  const crossing = crossingOf(l);
  return {
    key: `${key}:${l.id}`,
    target: { type: 'app', id: peer.id },
    line: row(PEER_COLUMNS, [
      peer.displayName,
      { text: clusterNameOf(t, peer.clusterId), paint: chalk.dim },
      l.label,
      { text: crossing, paint: chalk.dim },
    ]),
    note: noteOf(peer),
    notePaint: toneOf(peer.status),
  };
}

const ROUTE_COLUMNS: Column[] = [
  { width: 40 },
  { width: 8 },
  { width: 11, align: 'right' },
  { width: 12 },
];

function routeLine(l: TopologyLinkDto): string {
  const failing = l.traffic.measured && (l.traffic.errorPct ?? 0) >= 5;
  return row(ROUTE_COLUMNS, [
    routeUrl(l),
    l.targetPort ? `→ :${l.targetPort}` : '',
    l.traffic.measured
      ? rps(l.traffic.rps)
      : { text: 'not measured', paint: chalk.dim },
    l.traffic.measured
      ? {
          text: `${percent(l.traffic.errorPct)} errors`,
          paint: failing ? chalk.red : chalk.dim,
        }
      : '',
  ]);
}

export function appView(t: Snapshot, id: string): TopologyView | null {
  const a = t.apps.find((x) => x.id === id);
  if (!a) return null;
  const cluster = clusterNameOf(t, a.clusterId);
  const stack = t.stacks.find((s) => s.id === a.stackId);
  const project = (t.projects ?? []).find((p) => p.id === a.projectId);
  const paint = toneOf(a.status);
  const routes = routesTo(t, a.id);
  const calledBy = callersOf(t, a.id)
    .map((l) => peerEntry(t, l, l.from.appId!, 'caller'))
    .filter((e): e is TopologyEntry => !!e);
  const talksTo = calleesOf(t, a.id)
    .map((l) => peerEntry(t, l, l.to.appId!, 'callee'))
    .filter((e): e is TopologyEntry => !!e);
  const runsOn: TopologyEntry[] = a.replicas.map((r) => {
    const s = t.servers.find((x) => x.id === r.serverId);
    return {
      key: `replica:${r.serverId}`,
      target: { type: 'server', id: r.serverId },
      line: row(
        [
          { width: 20 },
          { width: 6, align: 'right' },
          { width: 14 },
          { width: 6 },
          { width: 22 },
        ],
        [
          s?.nodeName ?? r.serverId,
          `×${r.count}`,
          { text: s ? (ROLE[s.role] ?? s.role) : '', paint: chalk.dim },
          { text: s?.region ?? '—', paint: chalk.dim },
          {
            text: s
              ? `memory ${percent(s.capacity?.usedMemPct)} · cpu ${percent(s.capacity?.usedCpuPct)}`
              : '',
            paint: chalk.dim,
          },
        ],
      ),
    };
  });
  const trail = [
    'Fleet',
    cluster,
    ...(isSystem(a) ? ['Flui platform'] : []),
    a.displayName,
  ];
  const scaling = a.scalingNote ?? a.scalingMode;
  return {
    trail,
    summary: [
      `${chalk.bold(a.displayName)}  ${paint(statusLabel(a.status))}  ${cluster} · ${a.exposure} · ${categoryLabel(a.category)}`,
      ...(a.statusReason ? [paint(a.statusReason)] : []),
      ...facts([
        ['Replicas', `${a.replicaCount} · ${scaling}`],
        ['Traffic in', rps(trafficIn(t, a.id))],
        ['Memory', `${memory(a.ramRequestMB)}, limit ${memory(a.ramLimitMB)}`],
        ['CPU', `${cpu(a.cpuRequestM)}, limit ${cpu(a.cpuLimitM)}`],
        ['Stack', stack && stack.appIds.length > 1 ? stack.name : '—'],
        ['Project', project?.name ?? (isSystem(a) ? 'Flui platform' : '—')],
      ]),
    ],
    sections: [
      ...(routes.length
        ? [
            {
              title: 'Reachable from the Internet',
              lines: routes.map(routeLine),
            },
          ]
        : []),
      ...(calledBy.length ? [{ title: 'Called by', entries: calledBy }] : []),
      ...(talksTo.length ? [{ title: 'Talks to', entries: talksTo }] : []),
      { title: 'Runs on', entries: runsOn },
    ],
  };
}
