import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../api-client';
import { ConfigStorage } from '../config-storage';
import {
  TopologyMatch,
  appSlice,
  clusterSlice,
  findApp,
  findCluster,
  findServer,
  missMessage,
  serverSlice,
} from '../../../../src/modules/topology/utils/topology-slice.util';
import { openInBrowser } from '../browser-callback';
import { LiveTopology, liveTopology } from './topology-live';
import {
  NO_DASHBOARD_URL,
  dashboardBase,
  dashboardLink,
} from './topology-link';
import { navigateTopology } from './topology-navigator';
import { ConnectionState, connectionLabel } from './topology-format';
import {
  Snapshot,
  TopologyScreen,
  topologyView,
  viewLines,
} from './topology-view';

export const topologyFlags = {
  json: Flags.boolean({
    description: 'Print the matching part of the API response as JSON',
  }),
  system: Flags.boolean({
    description:
      'List the apps Flui runs for itself one by one instead of as one "Flui platform" entry',
  }),
  watch: Flags.boolean({
    description:
      'Stay open and redraw on every change, from the same live stream as the dashboard',
    exclusive: ['json'],
  }),
  'api-url': Flags.string({
    description:
      'Override the API base URL (e.g. http://localhost:3000/api/v1). Default: active profile.',
  }),
  profile: Flags.string({
    description:
      'Profile to read the credential from (default: active profile)',
  }),
  open: Flags.boolean({
    description: 'Also open this view in the dashboard Topology',
    exclusive: ['json'],
  }),
  'dashboard-url': Flags.string({
    description:
      'The dashboard address to link to (e.g. https://dashboard.example.com). Default: what the API says.',
  }),
};

export interface TopologyFlags {
  json: boolean;
  system: boolean;
  watch: boolean;
  'api-url'?: string;
  profile?: string;
  open?: boolean;
  'dashboard-url'?: string;
}

export type ScreenResolver = (t: Snapshot) => TopologyScreen | string;

function client(flags: TopologyFlags): ApiClient {
  const config = new ConfigStorage(flags.profile);
  return new ApiClient({
    baseUrl: flags['api-url'] ?? config.getApiUrlOrThrow(),
    apiKey: config.getApiKeyOrThrow(),
  });
}

const fetchSnapshot = (api: ApiClient, system: boolean) =>
  api.get<Snapshot>(`/topology${system ? '?system=1' : ''}`);

function sliceOf(t: Snapshot, screen: TopologyScreen): unknown {
  switch (screen.type) {
    case 'cluster':
    case 'platform':
      return clusterSlice(t, screen.id);
    case 'app':
      return appSlice(t, screen.id);
    case 'server':
      return serverSlice(t, screen.id);
    default:
      return t;
  }
}

function resolved<T extends { id: string }>(
  t: Snapshot,
  kind: 'cluster' | 'app' | 'server',
  ref: string,
  found: TopologyMatch<T>,
  clusterRef?: string,
): TopologyScreen | string {
  if ('found' in found)
    return { type: kind, id: found.found.id } as TopologyScreen;
  return missMessage(t, kind, ref, found.candidates as never[], clusterRef);
}

export const byCluster =
  (ref: string): ScreenResolver =>
  (t) =>
    resolved(t, 'cluster', ref, findCluster(t, ref));

export const byApp =
  (ref: string, clusterRef?: string): ScreenResolver =>
  (t) =>
    resolved(t, 'app', ref, findApp(t, ref, clusterRef), clusterRef);

export const byServer =
  (ref: string, clusterRef?: string): ScreenResolver =>
  (t) =>
    resolved(t, 'server', ref, findServer(t, ref, clusterRef), clusterRef);

export const fleet: ScreenResolver = () => ({ type: 'fleet' });

function honourNoColor(): void {
  if (process.env.NO_COLOR) chalk.level = 0;
}

/** Every `flui topology` form: one snapshot printed, kept live, or browsed. */
export async function runTopology(
  command: Command,
  flags: TopologyFlags,
  resolve: ScreenResolver,
  interactive = false,
): Promise<void> {
  honourNoColor();
  let api: ApiClient;
  let t: Snapshot;
  try {
    api = client(flags);
    // The renderer folds platform apps into one entry, so it always asks for them;
    // JSON mirrors the API, where they come only on request.
    t = await fetchSnapshot(api, flags.json ? flags.system : true);
  } catch (error) {
    command.error(`Could not read the topology: ${(error as Error).message}`, {
      exit: 1,
    });
  }
  const screen = resolve(t);
  if (typeof screen === 'string') command.error(screen, { exit: 1 });
  const options = { system: flags.system };
  let override = flags['dashboard-url'];
  if (!dashboardBase(t, override)) {
    override = new ConfigStorage(flags.profile).getDashboardUrl() ?? undefined;
  }
  if (flags.open) {
    const link = linkTo(t, screen, override);
    if (!link) command.warn(NO_DASHBOARD_URL);
    else if (process.stdout.isTTY && openInBrowser(link)) {
      command.log(`Opening ${link}\n`);
    } else command.log(`Open in the dashboard: ${link}\n`);
  }

  if (flags.json) {
    command.log(JSON.stringify(sliceOf(t, screen), null, 2));
    return;
  }
  if (interactive) {
    await browse(api, t, options, screen, override);
    return;
  }
  if (!flags.watch) {
    command.log(viewLines(topologyView(t, screen, options)!).join('\n'));
    return;
  }
  await watch(api, t, screen, options);
}

async function browse(
  api: ApiClient,
  initial: Snapshot,
  options: { system: boolean },
  start: TopologyScreen,
  override: string | undefined,
): Promise<void> {
  let snapshot = initial;
  let state: ConnectionState = 'connecting';
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const stream = liveTopology(api, true, initial, {
    onSnapshot: (next) => {
      snapshot = next;
      notify();
    },
    onConnection: (connected) => {
      state = connected ? 'live' : 'reconnecting';
      notify();
    },
  });
  try {
    await navigateTopology(
      {
        current: () => snapshot,
        connection: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      options,
      start,
      (screen) => {
        const link = linkTo(snapshot, screen, override);
        if (!link) return NO_DASHBOARD_URL;
        return openInBrowser(link)
          ? `Opened in the dashboard: ${link}`
          : `Open in the dashboard: ${link}`;
      },
    );
  } finally {
    stream.stop();
  }
}

function linkTo(
  t: Snapshot,
  screen: TopologyScreen,
  override: string | undefined,
): string | null {
  const base = dashboardBase(t, override);
  return base ? dashboardLink(base, t, screen) : null;
}

const RECENT = 4;
const RENDER_MIN_MS = 500;

/** Redraws one view on every change until Ctrl+C, with the last few changes under it. */
async function watch(
  api: ApiClient,
  initial: Snapshot,
  screen: TopologyScreen,
  options: { system: boolean },
): Promise<void> {
  const tty = !!process.stdout.isTTY;
  let snapshot = initial;
  let state: ConnectionState = 'connecting';
  let shown = '';
  let lastDraw = 0;
  let pending: NodeJS.Timeout | null = null;
  const recent: string[] = [];

  const body = () => {
    const view = topologyView(snapshot, screen, options);
    return view
      ? viewLines(view).join('\n')
      : chalk.yellow('It is no longer on the map.');
  };
  const draw = () => {
    pending = null;
    lastDraw = Date.now();
    const text = body();
    const changes = recent.length
      ? ['', chalk.bold('Changes'), ...recent.map((r) => `  ${r}`)]
      : [];
    const updated = `updated ${new Date().toLocaleTimeString()} · Ctrl+C to stop`;
    const footer = `${connectionLabel(state)}  ${chalk.dim(updated)}`;
    const frame = [text, ...changes, '', footer].join('\n');
    if (tty) {
      process.stdout.write(`\u001B[H\u001B[2J${frame}\n`);
      return;
    }
    const content = [text, ...changes].join('\n');
    if (content === shown) return;
    shown = content;
    process.stdout.write(`${frame}\n\n`);
  };
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(
      draw,
      Math.max(0, RENDER_MIN_MS - (Date.now() - lastDraw)),
    );
  };

  let stream: LiveTopology | null = null;
  if (tty) process.stdout.write('\u001B[?25l');
  draw();
  await new Promise<void>((done) => {
    stream = liveTopology(api, true, initial, {
      onSnapshot: (next, change) => {
        snapshot = next;
        if (change) {
          recent.unshift(
            `${chalk.dim(new Date().toLocaleTimeString())}  ${change}`,
          );
          recent.splice(RECENT);
        }
        schedule();
      },
      onConnection: (connected) => {
        state = connected ? 'live' : 'reconnecting';
        schedule();
      },
    });
    process.once('SIGINT', () => done());
    process.once('SIGTERM', () => done());
  });
  stream?.stop();
  if (pending) clearTimeout(pending);
  if (tty) process.stdout.write('\u001B[?25h\n');
}
