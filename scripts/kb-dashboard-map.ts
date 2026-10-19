/**
 * kb-dashboard-map — render the dashboard map for the assistant knowledge base.
 *
 * The curated map (knowledge/sources/authored/dashboard-map.yaml) says, per
 * dashboard page, where it sits in the menu, what it shows, what you can do and
 * the equivalent CLI command and MCP tool. This script is its drift guard and
 * renderer: it fails when a sidebar link of the dashboard checkout has no entry,
 * when an entry names a CLI command or MCP tool that does not exist, or when an
 * entry points at a route the sidebar no longer has; otherwise it writes
 * generated/dashboard-map.generated.md, one `##` block per page.
 *
 * Part of `pnpm kb`; kb-build compiles the output as the
 * `authored/dashboard-map` section.
 *
 *   FLUI_DASHBOARD_DIR=../flui-dashboard pnpm kb:dashboard-map [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, 'src/modules/assistant/knowledge');
const MAP = path.join(KB, 'sources/authored/dashboard-map.yaml');
const OUT = path.join(KB, 'generated/dashboard-map.generated.md');
const CLI_COMMANDS = path.join(ROOT, 'cli/src/commands');
const MCP_TOOLS = path.join(ROOT, 'src/modules/mcp/tools');

interface MapEntry {
  id: string;
  kind: 'page' | 'subpage';
  menu: string[] | null;
  route: string;
  title: string;
  shows: string;
  actions: string[];
  cli: string[];
  mcp: string[];
  sources: string[];
  notes?: string;
}

interface DashboardMap {
  generatedFrom: Record<string, string>;
  visibility_notes?: Array<{ text: string; source: string }>;
  entries: MapEntry[];
}

function dashboardDir(): string {
  const explicit = process.env.FLUI_DASHBOARD_DIR;
  const dir = explicit
    ? path.resolve(explicit)
    : path.join(ROOT, '..', 'flui-dashboard');
  if (!fs.existsSync(path.join(dir, 'src/app'))) {
    throw new Error(
      `kb-dashboard-map: no dashboard checkout at ${dir}. Set FLUI_DASHBOARD_DIR.`,
    );
  }
  return dir;
}

function sidebarLinks(dashboard: string): Set<string> {
  const app = path.join(dashboard, 'src/app');
  const files = [
    'layout/components/sidebar/sidebar-nav.config.ts',
    'layout/components/sidebar/sidebar.component.ts',
    'features/model/workload-list.ts',
    'layout/components/sidebar/sidebar.component.html',
  ];
  const links = new Set<string>();
  for (const rel of files) {
    const src = fs.readFileSync(path.join(app, rel), 'utf8');
    for (const m of src.matchAll(/\blink:\s*'([^']+)'/g)) links.add(m[1]);
    for (const m of src.matchAll(/\brouterLink="(\/[^"]+)"/g)) links.add(m[1]);
    if (rel.endsWith('workload-list.ts')) {
      const block = /WORKLOAD_LIST_ROUTE[^{]*\{([^}]*)\}/.exec(src)?.[1] ?? '';
      for (const m of block.matchAll(/'(\/[^']+)'/g)) links.add(m[1]);
    }
  }
  return links;
}

function cliCommandIds(): Set<string> {
  const ids = new Set<string>();
  const walk = (dir: string, prefix: string[]): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full, [...prefix, name]);
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        const base = name.replace(/\.ts$/, '');
        const parts = base === 'index' ? prefix : [...prefix, base];
        if (parts.length) ids.add(['flui', ...parts].join(' '));
      }
    }
  };
  walk(CLI_COMMANDS, []);
  return ids;
}

function mcpToolNames(): Set<string> {
  const names = new Set<string>();
  for (const file of fs.readdirSync(MCP_TOOLS)) {
    if (!file.endsWith('.tools.ts')) continue;
    const src = fs.readFileSync(path.join(MCP_TOOLS, file), 'utf8');
    for (const m of src.matchAll(/\bname:\s*'([a-z][a-z0-9_]*)'/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

function commandOf(invocation: string): string {
  return invocation
    .split(/\s+/)
    .filter((w) => !w.startsWith('-') && !w.startsWith('<'))
    .join(' ');
}

function validate(
  map: DashboardMap,
  links: Set<string>,
  cli: Set<string>,
  mcp: Set<string>,
): string[] {
  const problems: string[] = [];
  const routes = new Set(map.entries.map((e) => e.route));
  for (const link of links) {
    if (!routes.has(link)) problems.push(`sidebar link without entry: ${link}`);
  }
  const ids = new Set<string>();
  for (const e of map.entries) {
    if (ids.has(e.id)) problems.push(`duplicate id: ${e.id}`);
    ids.add(e.id);
    if (e.kind === 'page' && e.menu && !links.has(e.route)) {
      problems.push(`${e.id}: route ${e.route} is not a sidebar link`);
    }
    for (const c of e.cli ?? []) {
      if (!cli.has(commandOf(c))) problems.push(`${e.id}: unknown CLI "${c}"`);
    }
    for (const t of e.mcp ?? []) {
      if (!mcp.has(t)) problems.push(`${e.id}: unknown MCP tool "${t}"`);
    }
  }
  return problems;
}

function render(map: DashboardMap): string {
  const lines: string[] = [
    '---',
    'title: Dashboard map',
    'description: "Where each page of the Flui dashboard sits in the menu, what it shows, what you can do there, and the equivalent CLI command and agent tool."',
    '---',
    '',
    'Each block below is one page of the dashboard. "Menu" is the path in the',
    'sidebar. "CLI" and "Agent tool" are the equivalent command and MCP tool;',
    'none listed means the page has no direct equivalent.',
  ];
  const pages = map.entries.filter((e) => e.kind === 'page');
  const subpages = map.entries.filter((e) => e.kind === 'subpage');
  for (const e of [...pages, ...subpages]) {
    const menu = e.menu?.length ? e.menu.join(' › ') : 'not in the menu';
    lines.push(
      '',
      `## ${e.title}`,
      '',
      `- Menu: ${menu}`,
      `- Address: \`${e.route}\``,
    );
    lines.push(`- Shows: ${e.shows}`);
    if (e.actions?.length) lines.push(`- You can: ${e.actions.join('; ')}`);
    if (e.cli?.length)
      lines.push(`- CLI: ${e.cli.map((c) => `\`${c}\``).join(', ')}`);
    if (e.mcp?.length)
      lines.push(`- Agent tool: ${e.mcp.map((t) => `\`${t}\``).join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const map = yaml.load(fs.readFileSync(MAP, 'utf8')) as DashboardMap;
  const problems = validate(
    map,
    sidebarLinks(dashboardDir()),
    cliCommandIds(),
    mcpToolNames(),
  );
  if (problems.length) {
    console.error(`kb-dashboard-map: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (checkOnly) {
    console.log(`kb-dashboard-map: ${map.entries.length} entries, clean`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render(map));
  console.log(
    `kb-dashboard-map: ${map.entries.length} entries → ${path.relative(ROOT, OUT)}`,
  );
}

main();
