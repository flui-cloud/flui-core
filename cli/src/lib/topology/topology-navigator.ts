import chalk from 'chalk';
import * as readline from 'node:readline';
import { Separator, search, select } from '@inquirer/prompts';
import {
  Snapshot,
  TopologyScreen,
  TopologyView,
  ViewOptions,
  pathTo,
  screenKey,
  screenLabel,
  topologyView,
} from './topology-view';
import { isSystem } from '../../../../src/modules/topology/utils/topology-slice.util';
import { ConnectionState, connectionLabel, truncate } from './topology-format';

type Outcome =
  | { kind: 'open'; target: TopologyScreen }
  | { kind: 'back' }
  | { kind: 'search' }
  | { kind: 'dashboard'; target: TopologyScreen }
  | { kind: 'quit' }
  | { kind: 'refresh' };

/** What the navigator needs from the live snapshot. */
export interface NavigatorSource {
  current(): Snapshot;
  connection(): ConnectionState;
  /** Called on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const KEY_SEP = '\u001F';
const HELP = `${chalk.bold('↑↓')} ${chalk.dim('move')}  ${chalk.bold('⏎')} ${chalk.dim('open')}  ${chalk.bold('esc')} ${chalk.dim('back')}  ${chalk.bold('/')} ${chalk.dim('search')}  ${chalk.bold('o')} ${chalk.dim('open in dashboard')}  ${chalk.bold('q')} ${chalk.dim('quit')}`;
const CLEAR = '\u001B[H\u001B[2J';
const REFRESH_MIN_MS = 1000;
const FLEET: TopologyScreen = { type: 'fleet' };

/** Everything the screen shows above the list, and the list itself as choices. */
export function screenText(
  t: Snapshot,
  stack: TopologyScreen[],
  view: TopologyView,
  connection: ConnectionState,
): string[] {
  const trail = stack.map((s) => screenLabel(t, s)).join(' › ');
  const state = connectionLabel(connection);
  const width = Math.min(process.stdout.columns || 80, 100);
  const room = Math.max(10, width - 16);
  return [
    `${chalk.bold(truncate(trail, room).padEnd(room))}  ${state}`,
    ...view.summary,
    '',
  ];
}

export function choicesOf(view: TopologyView) {
  const choices: Array<
    Separator | { value: string; name: string; description: string }
  > = [];
  const targets = new Map<string, TopologyScreen>();
  view.sections.forEach((section, i) => {
    if (i > 0) choices.push(new Separator(' '));
    choices.push(new Separator(chalk.bold(section.title)));
    if (section.header)
      choices.push(new Separator(chalk.dim(` ${section.header}`)));
    for (const entry of section.entries ?? []) {
      targets.set(entry.key, entry.target);
      choices.push({
        value: entry.key,
        name: entry.line,
        description: `${entry.key}${KEY_SEP}${entry.note ? (entry.notePaint ?? chalk.dim)(entry.note) : ''}`,
      });
    }
    for (const line of section.lines ?? [])
      choices.push(new Separator(` ${line}`));
  });
  return { choices, targets };
}

/**
 * The interactive Topology: Fleet, then a cluster, then an app or a server,
 * the same levels as the dashboard map. Live changes redraw the screen in place
 * and keep the row the cursor was on.
 */
export async function navigateTopology(
  source: NavigatorSource,
  options: ViewOptions,
  start: TopologyScreen = FLEET,
  openInDashboard?: (screen: TopologyScreen) => string,
): Promise<void> {
  let stack = pathTo(source.current(), start);
  const cursor = new Map<string, string>();
  let status: string | null = null;
  readline.emitKeypressEvents(process.stdin);
  process.stdout.write('\u001B[?1049h');
  try {
    for (;;) {
      const t = source.current();
      dropHidden(t, stack, options);
      const screen = topOf(stack);
      const view = topologyView(t, screen, options)!;
      const outcome = await showScreen(
        source,
        stack,
        view,
        cursor,
        screenKey(screen),
        status,
      );
      if (outcome.kind === 'quit') return;
      if (outcome.kind === 'dashboard') {
        status = openInDashboard
          ? openInDashboard(outcome.target)
          : 'Opening in the dashboard is not available here.';
        continue;
      }
      if (outcome.kind !== 'refresh') status = null;
      const next = await nextStack(source, stack, outcome, cursor);
      if (next === 'quit') return;
      stack = next;
    }
  } finally {
    process.stdout.write('\u001B[?1049l');
  }
}

function topOf(stack: TopologyScreen[]): TopologyScreen {
  const [top] = stack.slice(-1);
  return top;
}

function dropHidden(
  t: Snapshot,
  stack: TopologyScreen[],
  options: ViewOptions,
): void {
  while (stack.length > 1 && !topologyView(t, topOf(stack), options))
    stack.pop();
}

async function nextStack(
  source: NavigatorSource,
  stack: TopologyScreen[],
  outcome: Outcome,
  cursor: Map<string, string>,
): Promise<TopologyScreen[] | 'quit'> {
  switch (outcome.kind) {
    case 'back':
      return stack.length > 1 ? stack.slice(0, -1) : stack;
    case 'open':
      return [...stack, outcome.target];
    case 'search':
      return searchedStack(source, stack, cursor);
    default:
      return stack;
  }
}

async function searchedStack(
  source: NavigatorSource,
  stack: TopologyScreen[],
  cursor: Map<string, string>,
): Promise<TopologyScreen[] | 'quit'> {
  const found = await searchFleet(source.current());
  if (found === 'quit') return 'quit';
  if (!found) return stack;
  const path = pathTo(source.current(), found);
  path
    .slice(1)
    .forEach((child, i) => cursor.set(screenKey(path[i]), screenKey(child)));
  return path;
}

async function showScreen(
  source: NavigatorSource,
  stack: TopologyScreen[],
  view: TopologyView,
  cursor: Map<string, string>,
  key: string,
  status: string | null,
): Promise<Outcome> {
  const t = source.current();
  const head = [
    ...screenText(t, stack, view, source.connection()),
    ...(status ? [chalk.cyan(status), ''] : []),
  ];
  const { choices, targets } = choicesOf(view);
  if (!targets.size)
    choices.push({
      value: '',
      name: chalk.dim('Nothing to open here'),
      description: KEY_SEP,
    });
  const rows = process.stdout.rows || 24;
  process.stdout.write(CLEAR + head.join('\n') + '\n');
  const controller = new AbortController();
  let outcome: Outcome | null = null;
  const finish = (o: Outcome) => {
    if (outcome) return;
    outcome = o;
    controller.abort();
  };
  const onKey = (
    _: string,
    k: { name?: string; sequence?: string; ctrl?: boolean },
  ) => {
    if (k?.name === 'escape' || k?.name === 'backspace' || k?.name === 'left')
      finish({ kind: 'back' });
    else if (k?.sequence === '/') finish({ kind: 'search' });
    else if (k?.sequence === 'o')
      finish({
        kind: 'dashboard',
        target: targets.get(cursor.get(key) ?? '') ?? topOf(stack),
      });
    else if (k?.sequence === 'q') finish({ kind: 'quit' });
  };
  let last = Date.now();
  let pending: NodeJS.Timeout | null = null;
  const unsubscribe = source.subscribe(() => {
    if (pending) return;
    const wait = Math.max(0, REFRESH_MIN_MS - (Date.now() - last));
    pending = setTimeout(() => {
      pending = null;
      last = Date.now();
      finish({ kind: 'refresh' });
    }, wait);
  });
  process.stdin.on('keypress', onKey);
  try {
    const chosen = await select(
      {
        message: '',
        choices,
        default: cursor.get(key),
        loop: false,
        pageSize: Math.max(5, rows - head.length - 4),
        theme: {
          prefix: { idle: '', done: '' },
          style: {
            highlight: (text: string) => chalk.inverse(text),
            // The select draws only the active row's description, which is how the
            // row under the cursor is known; keys this screen acts on (esc, q, /)
            // also reach the select's type-ahead, which must not move it.
            description: (text: string) => {
              const [active, note] = text.split(KEY_SEP);
              if (active && !outcome) cursor.set(key, active);
              return note ? `  ${note}` : '';
            },
            keysHelpTip: () => HELP,
          },
        },
      },
      { signal: controller.signal, clearPromptOnDone: true },
    );
    const target = targets.get(chosen);
    return target ? { kind: 'open', target } : { kind: 'refresh' };
  } catch (error) {
    if (outcome) return outcome;
    if ((error as Error)?.name === 'ExitPromptError') return { kind: 'quit' };
    throw error;
  } finally {
    process.stdin.removeListener('keypress', onKey);
    unsubscribe();
    if (pending) clearTimeout(pending);
  }
}

interface Findable {
  screen: TopologyScreen;
  name: string;
  line: string;
}

const findLine = (name: string, detail: string) =>
  `${name.padEnd(24)} ${chalk.dim(detail)}`;

function findables(t: Snapshot): Findable[] {
  const cluster = (id: string) =>
    t.clusters.find((c) => c.id === id)?.name ?? '';
  return [
    ...t.clusters.map((c) => ({
      screen: { type: 'cluster' as const, id: c.id },
      name: c.name,
      line: findLine(c.name, `cluster · ${c.provider} · ${c.region}`),
    })),
    ...t.apps.map((a) => ({
      screen: { type: 'app' as const, id: a.id },
      name: `${a.displayName} ${a.name}`,
      line: findLine(
        truncate(a.displayName, 24),
        `${isSystem(a) ? 'platform app' : 'app'} · ${cluster(a.clusterId)}`,
      ),
    })),
    ...t.servers.map((s) => ({
      screen: { type: 'server' as const, id: s.id },
      name: s.nodeName,
      line: findLine(
        truncate(s.nodeName, 24),
        `server · ${cluster(s.clusterId)}`,
      ),
    })),
  ];
}

async function searchFleet(
  t: Snapshot,
): Promise<TopologyScreen | 'quit' | null> {
  process.stdout.write(CLEAR);
  const all = findables(t);
  const controller = new AbortController();
  const onKey = (_: string, k: { name?: string }) => {
    if (k?.name === 'escape') controller.abort();
  };
  process.stdin.on('keypress', onKey);
  try {
    const index = await search<number>(
      {
        message: 'Find a cluster, app or server',
        pageSize: Math.max(5, (process.stdout.rows || 24) - 4),
        source: (term) => {
          const needle = (term ?? '').toLowerCase();
          return all
            .map((f, i) => ({ f, i }))
            .filter(({ f }) => f.name.toLowerCase().includes(needle))
            .map(({ f, i }) => ({ value: i, name: f.line }));
        },
        theme: {
          style: {
            keysHelpTip: () =>
              `${chalk.bold('⏎')} ${chalk.dim('open')}  ${chalk.bold('esc')} ${chalk.dim('back')}`,
          },
        },
      },
      { signal: controller.signal, clearPromptOnDone: true },
    );
    return all[index]?.screen ?? null;
  } catch (error) {
    if ((error as Error)?.name === 'AbortPromptError') return null;
    if ((error as Error)?.name === 'ExitPromptError') return 'quit';
    throw error;
  } finally {
    process.stdin.removeListener('keypress', onKey);
  }
}
