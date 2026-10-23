import chalk from 'chalk';
import type {
  TopologyAppDto,
  TopologyServerDto,
} from '../../../../src/modules/topology/dto/topology.dto';
import {
  isSystem,
  isTroubled,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import {
  Column,
  overlayLabel,
  percent,
  plural,
  row,
  statusLabel,
  toneOf,
  usePaint,
} from './topology-format';
import { inboundLines } from './topology-view-firewall';
import { platformEntry } from './topology-view-platform';
import {
  APP_HEADER,
  ARCH,
  ROLE,
  appEntry,
  byStackThenName,
  userApps,
} from './topology-view-shared';
import type {
  Snapshot,
  TopologyEntry,
  TopologySection,
  TopologyView,
  ViewOptions,
} from './topology-view-types';

interface AppGroup {
  title: string;
  apps: TopologyAppDto[];
  project: boolean;
}

/** A cluster's own apps by project, the way its screen lists them. */
function appGroups(t: Snapshot, apps: TopologyAppDto[]): AppGroup[] {
  const own = userApps(apps).sort(byStackThenName(t));
  const projects = t.projects ?? [];
  return [
    ...projects.map((p) => ({
      title: p.name,
      apps: own.filter((a) => a.projectId === p.id),
      project: true,
    })),
    {
      title: projects.length ? 'No project' : 'Apps',
      apps: own.filter(
        (a) => !a.projectId || !projects.some((p) => p.id === a.projectId),
      ),
      project: false,
    },
  ].filter((g) => g.apps.length);
}

/** "8 apps in 2 projects": the same count as the groups below it. */
function appCount(groups: AppGroup[]): string {
  const total = groups.reduce((n, g) => n + g.apps.length, 0);
  const projects = groups.filter((g) => g.project);
  if (!projects.length) return plural(total, 'app');
  const loose = groups.find((g) => !g.project)?.apps.length ?? 0;
  const none = loose ? `, ${loose} in none` : '';
  return `${plural(total, 'app')} in ${plural(projects.length, 'project')}${none}`;
}

function appSections(groups: AppGroup[], t: Snapshot): TopologySection[] {
  return groups.map((g) => ({
    title: g.title,
    header: APP_HEADER,
    entries: g.apps.map((a) => appEntry(t, a)),
  }));
}

const SERVER_COLUMNS: Column[] = [
  { width: 17 },
  { width: 7 },
  { width: 6 },
  { width: 9 },
  { width: 4 },
  { width: 6, align: 'right' },
  { width: 4, align: 'right' },
  { width: 8, align: 'right' },
];

const SHORT_ROLE: Record<string, string> = {
  'control-plane': 'control',
  worker: 'worker',
};

function serverEntry(s: TopologyServerDto): TopologyEntry {
  const mem = s.capacity?.usedMemPct;
  const cpuPct = s.capacity?.usedCpuPct;
  return {
    key: `server:${s.id}`,
    target: { type: 'server', id: s.id },
    line: row(SERVER_COLUMNS, [
      s.nodeName,
      SHORT_ROLE[s.role] ?? ROLE[s.role] ?? s.role,
      s.region ?? '—',
      s.serverType ?? '—',
      ARCH[s.architecture ?? ''] ?? '—',
      { text: percent(mem), paint: usePaint(mem) },
      { text: percent(cpuPct), paint: usePaint(cpuPct) },
      String(s.podCount),
    ]),
    note: s.status === 'healthy' ? undefined : statusLabel(s.status),
    notePaint: toneOf(s.status),
  };
}

function platformSections(
  t: Snapshot,
  id: string,
  system: TopologyAppDto[],
  options: ViewOptions,
): TopologySection[] {
  if (!system.length) return [];
  const entries = options.system
    ? [...system].sort(byStackThenName(t)).map((a) => appEntry(t, a))
    : [platformEntry(t, id, system)];
  return [{ title: 'Flui platform', header: APP_HEADER, entries }];
}

export function clusterView(
  t: Snapshot,
  id: string,
  options: ViewOptions,
): TopologyView | null {
  const c = t.clusters.find((x) => x.id === id);
  if (!c) return null;
  const apps = t.apps.filter((a) => a.clusterId === id);
  const servers = t.servers.filter((s) => s.clusterId === id);
  const system = apps.filter(isSystem);
  const problems = apps.filter(isTroubled).length;
  const groups = appGroups(t, apps);
  const inbound = inboundLines(t, id);
  const platform = platformSections(t, id, system, options);
  return {
    trail: ['Fleet', c.name],
    summary: [
      `${chalk.bold(c.name)}  ${c.provider} · ${c.region} · ${c.type}  ${toneOf(c.status)(statusLabel(c.status))}`,
      [
        plural(servers.length, 'server'),
        appCount(groups),
        ...(system.length ? [`${system.length} platform apps`] : []),
        problems ? chalk.yellow(plural(problems, 'problem')) : 'no problems',
      ].join(' · '),
      `Reached over ${overlayLabel(c.overlay)}`,
      ...inbound.map((line) => chalk.dim(line)),
    ],
    sections: [
      ...appSections(groups, t),
      ...platform,
      {
        title: 'Servers',
        header: row(SERVER_COLUMNS, [
          'SERVER',
          'ROLE',
          'REGION',
          'TYPE',
          'ARCH',
          'MEMORY',
          'CPU',
          'REPLICAS',
        ]),
        entries: servers.map(serverEntry),
      },
    ],
  };
}
