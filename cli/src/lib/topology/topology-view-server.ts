import chalk from 'chalk';
import type { TopologyAppDto } from '../../../../src/modules/topology/dto/topology.dto';
import {
  appsOnServer,
  clusterNameOf,
  isSystem,
  worstAppStatus,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import {
  Column,
  cpu,
  facts,
  memory,
  percent,
  plural,
  row,
  statusLabel,
  toneOf,
  usePaint,
} from './topology-format';
import { ARCH, ROLE, noteOf, userApps } from './topology-view-shared';
import type {
  Snapshot,
  TopologyEntry,
  TopologyView,
  ViewOptions,
} from './topology-view-types';

export function serverView(
  t: Snapshot,
  id: string,
  options: ViewOptions,
): TopologyView | null {
  const s = t.servers.find((x) => x.id === id);
  if (!s) return null;
  const hosted = appsOnServer(t, s.id);
  const here = (a: TopologyAppDto) =>
    a.replicas.find((r) => r.serverId === s.id)?.count ?? 0;
  const columns: Column[] = [
    { width: 24 },
    { width: 6, align: 'right' },
    { width: 9 },
    { width: 22 },
  ];
  const appLine = (a: TopologyAppDto) =>
    row(columns, [
      a.displayName,
      `×${here(a)}`,
      { text: statusLabel(a.status), paint: toneOf(a.status) },
      {
        text: `${memory(a.ramRequestMB * here(a))} requested`,
        paint: chalk.dim,
      },
    ]);
  const users = userApps(hosted).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
  const system = hosted.filter(isSystem);
  const entries: TopologyEntry[] = [
    ...(options.system ? [...users, ...system] : users).map((a) => ({
      key: `app:${a.id}`,
      target: { type: 'app' as const, id: a.id },
      line: appLine(a),
      note: noteOf(a),
      notePaint: toneOf(a.status),
    })),
    ...(!options.system && system.length
      ? [
          {
            key: `platform:${s.clusterId}`,
            target: { type: 'platform' as const, id: s.clusterId },
            line: row(columns, [
              `Flui platform (${system.length})`,
              `×${system.reduce((n, a) => n + here(a), 0)}`,
              {
                text: statusLabel(worstAppStatus(system)),
                paint: toneOf(worstAppStatus(system)),
              },
              {
                text: `${memory(system.reduce((n, a) => n + a.ramRequestMB * here(a), 0))} requested`,
                paint: chalk.dim,
              },
            ]),
          },
        ]
      : []),
  ];
  const cap = s.capacity;
  const reserved = cap
    ? `${memory(cap.requestedMemMi)} of ${memory(cap.allocatableMemMi)}`
    : '—';
  const network: Record<string, string> = {
    active: 'connected',
    pending: 'waiting for its first handshake',
    stale: 'not answering',
    none: 'not on it',
  };
  return {
    trail: ['Fleet', clusterNameOf(t, s.clusterId), s.nodeName],
    summary: [
      `${chalk.bold(s.nodeName)}  ${toneOf(s.status)(statusLabel(s.status))}  ${clusterNameOf(t, s.clusterId)} · ${s.provider}`,
      ...facts([
        [
          'Role',
          `${ROLE[s.role] ?? s.role}${s.takesWork ? ' · takes work' : ' · no new apps'}`,
        ],
        [
          'Type',
          `${s.serverType ?? '—'} · ${ARCH[s.architecture ?? ''] ?? '—'}`,
        ],
        ['Region', s.region ?? '—'],
        ['Memory used', percent(cap?.usedMemPct), usePaint(cap?.usedMemPct)],
        ['CPU used', percent(cap?.usedCpuPct), usePaint(cap?.usedCpuPct)],
        ['Mem reserved', reserved],
        [
          'CPU reserved',
          cap
            ? `${cpu(cap.requestedCpuM)} of ${cpu(cap.allocatableCpuM)}`
            : '—',
        ],
        ['Flui network', network[s.fluiNetwork] ?? '—'],
        ['Private net', s.privateNetwork ? 'yes' : 'no'],
      ]),
    ],
    sections: [
      {
        title: `Runs here (${plural(s.podCount, 'replica')})`,
        header: row(columns, ['APP', 'HERE', 'STATUS', 'MEMORY']),
        entries,
      },
    ],
  };
}
