/**
 * kb-cli-ref — empirical CLI reference for the assistant knowledge base.
 *
 * Runs `oclif manifest` against the built CLI (ground truth: every command, flag,
 * arg and example as the CLI actually exposes them) and renders a human-inspectable
 * Markdown reference, stamped with the CLI version. Output is committed so the KB is
 * auditable and the build is self-contained.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const CLI_DIR = path.join(ROOT, 'cli');
const MANIFEST = path.join(CLI_DIR, 'oclif.manifest.json');
const OUT_DIR = path.join(ROOT, 'src/modules/assistant/knowledge/generated');
const OUT = path.join(OUT_DIR, 'cli-reference.generated.md');

interface ManifestFlag {
  type?: string;
  description?: string;
  required?: boolean;
  char?: string;
  options?: string[];
  default?: unknown;
}

interface ManifestArg {
  name?: string;
  description?: string;
  required?: boolean;
}

interface ManifestCommand {
  id: string;
  summary?: string;
  description?: string;
  hidden?: boolean;
  aliases?: string[];
  flags?: Record<string, ManifestFlag>;
  args?: Record<string, ManifestArg>;
  examples?: Array<string | { command?: string; description?: string }>;
}

interface OclifManifest {
  version: string;
  commands: Record<string, ManifestCommand>;
}

function buildManifest(): OclifManifest {
  execFileSync('npx', ['oclif', 'manifest'], {
    cwd: CLI_DIR,
    stdio: 'inherit',
  });
  const raw = fs.readFileSync(MANIFEST, 'utf8');
  fs.rmSync(MANIFEST, { force: true });
  return JSON.parse(raw) as OclifManifest;
}

function cliVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

function topicOf(id: string): string {
  return id.includes(':') ? id.split(':')[0] : '(root)';
}

function renderFlags(flags: Record<string, ManifestFlag>): string[] {
  return Object.entries(flags).map(([name, f]) => {
    const alias = f.char ? `-${f.char}, ` : '';
    const req = f.required ? ' (required)' : '';
    const opts = f.options?.length ? ` [${f.options.join(' | ')}]` : '';
    const def =
      f.default !== undefined ? ` (default: ${JSON.stringify(f.default)})` : '';
    const desc = f.description ? ` — ${f.description}` : '';
    return `  - \`${alias}--${name}\`${opts}${req}${def}${desc}`;
  });
}

function renderArgs(args: Record<string, ManifestArg>): string[] {
  return Object.entries(args).map(([name, a]) => {
    const req = a.required ? ' (required)' : '';
    const desc = a.description ? ` — ${a.description}` : '';
    return `  - \`${name}\`${req}${desc}`;
  });
}

function renderCommand(cmd: ManifestCommand): string {
  const invocation = cmd.id.replace(/:/g, ' ');
  const lines: string[] = [`### \`flui ${invocation}\``];
  const summary = cmd.summary ?? cmd.description;
  if (summary) lines.push('', summary.trim());
  if (cmd.aliases?.length) lines.push('', `Aliases: ${cmd.aliases.join(', ')}`);

  const args = cmd.args ?? {};
  if (Object.keys(args).length) {
    lines.push('', 'Arguments:', ...renderArgs(args));
  }
  const flags = cmd.flags ?? {};
  if (Object.keys(flags).length) {
    lines.push('', 'Flags:', ...renderFlags(flags));
  }
  const examples = (cmd.examples ?? [])
    .map((e) => (typeof e === 'string' ? e : (e.command ?? '')))
    .filter(Boolean);
  if (examples.length) {
    lines.push('', 'Examples:', '```bash', ...examples, '```');
  }
  return lines.join('\n');
}

function main(): void {
  const manifest = buildManifest();
  const version = cliVersion();
  const commands = Object.values(manifest.commands)
    .filter((c) => !c.hidden)
    .sort((a, b) => a.id.localeCompare(b.id));

  const byTopic = new Map<string, ManifestCommand[]>();
  for (const cmd of commands) {
    const topic = topicOf(cmd.id);
    (byTopic.get(topic) ?? byTopic.set(topic, []).get(topic)!).push(cmd);
  }

  const out: string[] = [
    `# Flui CLI reference (generated)`,
    '',
    `> Generated from \`oclif manifest\` for flui CLI \`${version}\`. Do not edit by hand —`,
    `> regenerate with \`pnpm kb:cli-ref\`. This is the assistant's ground truth for commands.`,
    '',
    `CLI version: **${version}** · commands: **${commands.length}**`,
  ];

  for (const topic of [...byTopic.keys()].sort()) {
    out.push('', `## ${topic}`);
    for (const cmd of byTopic.get(topic)!) {
      out.push('', renderCommand(cmd));
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, out.join('\n') + '\n');
  console.log(
    `kb-cli-ref: wrote ${commands.length} commands (CLI ${version}) → ${path.relative(ROOT, OUT)}`,
  );
}

main();
