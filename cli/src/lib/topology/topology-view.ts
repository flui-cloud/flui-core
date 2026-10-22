import chalk from 'chalk';
import {
  clusterNameOf,
  isSystem,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import { truncate } from './topology-format';
import { appView } from './topology-view-app';
import { clusterView } from './topology-view-cluster';
import { fleetView } from './topology-view-fleet';
import { platformView } from './topology-view-platform';
import { serverView } from './topology-view-server';
import type {
  Snapshot,
  TopologyScreen,
  TopologyView,
  ViewOptions,
} from './topology-view-types';

export type {
  Snapshot,
  TopologyEntry,
  TopologyScreen,
  TopologySection,
  TopologyView,
  ViewOptions,
} from './topology-view-types';

export const screenKey = (s: TopologyScreen): string =>
  s.type === 'fleet' ? 'fleet' : `${s.type}:${s.id}`;

const ROW_INDENT = '  ';

export function topologyView(
  t: Snapshot,
  screen: TopologyScreen,
  options: ViewOptions,
): TopologyView | null {
  switch (screen.type) {
    case 'fleet':
      return fleetView(t);
    case 'cluster':
      return clusterView(t, screen.id, options);
    case 'platform':
      return platformView(t, screen.id);
    case 'app':
      return appView(t, screen.id);
    case 'server':
      return serverView(t, screen.id, options);
  }
}

/** The entities above a screen, so a view opened by name still shows where it sits. */
export function pathTo(t: Snapshot, screen: TopologyScreen): TopologyScreen[] {
  const fleet: TopologyScreen = { type: 'fleet' };
  const cluster = (id: string): TopologyScreen => ({ type: 'cluster', id });
  switch (screen.type) {
    case 'fleet':
      return [fleet];
    case 'cluster':
      return [fleet, screen];
    case 'platform':
      return [fleet, cluster(screen.id), screen];
    case 'app': {
      const app = t.apps.find((a) => a.id === screen.id);
      if (!app) return [fleet, screen];
      const above = [fleet, cluster(app.clusterId)];
      if (isSystem(app)) above.push({ type: 'platform', id: app.clusterId });
      return [...above, screen];
    }
    case 'server': {
      const server = t.servers.find((s) => s.id === screen.id);
      return server
        ? [fleet, cluster(server.clusterId), screen]
        : [fleet, screen];
    }
  }
}

export function screenLabel(t: Snapshot, screen: TopologyScreen): string {
  switch (screen.type) {
    case 'fleet':
      return 'Fleet';
    case 'cluster':
      return clusterNameOf(t, screen.id) || screen.id;
    case 'platform':
      return 'Flui platform';
    case 'app':
      return t.apps.find((a) => a.id === screen.id)?.displayName ?? screen.id;
    case 'server':
      return t.servers.find((s) => s.id === screen.id)?.nodeName ?? screen.id;
  }
}

/** A view as plain lines, for a script or a pipe; problem reasons go under their row. */
export function viewLines(view: TopologyView): string[] {
  const out = [chalk.bold(view.trail.join(' › ')), ...view.summary];
  for (const section of view.sections) {
    out.push('', chalk.bold(section.title));
    if (section.header) out.push(chalk.dim(`${ROW_INDENT}${section.header}`));
    for (const entry of section.entries ?? []) {
      out.push(`${ROW_INDENT}${entry.line}`);
      if (entry.note)
        out.push(
          `${ROW_INDENT}  ${(entry.notePaint ?? chalk.dim)(truncate(entry.note, 74))}`,
        );
    }
    for (const line of section.lines ?? []) out.push(`${ROW_INDENT}${line}`);
  }
  return out;
}
