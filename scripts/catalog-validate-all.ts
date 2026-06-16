#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Sequential end-to-end validation of the whole catalog, one app at a time.
 *
 * For every seed manifest under src/modules/catalog/seed it runs the per-app
 * smoke-test (scripts/catalog-smoke-test.ts) with a capacity gate, installs
 * with a DNS-only endpoint (no per-app certificate, to dodge Let's Encrypt
 * rate limits), waits for full teardown before the next app, and accumulates
 * a pass/fail/skip matrix. A small set of representative apps additionally run
 * the deep suite (real cert endpoint, resize, backup/snapshot, db tunnel).
 *
 * Usage:
 *   pnpm run catalog:validate-all --cluster <id> [options]
 *
 * Options:
 *   --cluster <id>        Target cluster UUID (or env FLUI_CLUSTER_ID)
 *   --token <token>       API bearer token (or env FLUI_API_KEY)
 *   --base-url <url>      API base URL (or env FLUI_API_URL)
 *   --results-dir <dir>   Where per-app results + summary.json are written
 *                         (default: runs/catalog-<timestamp>)
 *   --only a,b,c          Restrict to these slugs
 *   --exclude a,b,c       Skip these slugs
 *   --deep a,b,c          Slugs that run the deep suite
 *                         (default: postgresql,vaultwarden,wordpress-composed)
 *   --bulk-endpoint <m>   Endpoint mode for non-deep apps: none|dns|tls (default dns)
 *   --cert-provider <p>   Cert issuer for deep apps (default lets-encrypt-staging)
 *   --timeout <ms>        Per-app polling timeout (default 900000)
 *   --seed-dir <dir>      Override the seed directory
 *   --include-drafts      Also validate manifests flagged draft:true
 *
 * Exit codes:
 *   0  every app reached RUNNING or was cleanly SKIPPED (capacity)
 *   1  at least one app FAILED / TIMEOUT / ERROR
 *   2  usage error
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import { resolve, join } from 'path';
import { spawn } from 'child_process';
import * as yaml from 'js-yaml';
import { ConfigStorage } from '../cli/src/lib/config-storage';
import { ProfileManager } from '../cli/src/lib/profile-manager';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const REPO_ROOT = resolve(__dirname, '..');
const SMOKE_SCRIPT = 'scripts/catalog-smoke-test.ts';
const DEFAULT_SEED_DIR = 'src/modules/catalog/seed';
const DEFAULT_DEEP = ['postgresql', 'vaultwarden', 'wordpress-composed'];

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

interface DeepOpResult {
  passed: boolean;
  skipped?: boolean;
  message: string;
}

interface SmokeResult {
  file: string;
  slug: string;
  version: string;
  status: 'dry-run-ok' | 'RUNNING' | 'FAILED' | 'TIMEOUT' | 'ERROR' | 'SKIPPED';
  durationMs: number;
  capacity?: { canDeploy: boolean; message?: string };
  smokeTestPassed?: boolean;
  smokeTestMessage?: string;
  endpointVerification?: Array<{ passed: boolean }>;
  endpointHtml?: {
    reachable: boolean;
    status?: number;
    title?: string;
    message: string;
  };
  deep?: {
    resize?: DeepOpResult;
    backup?: DeepOpResult;
    tunnel?: DeepOpResult;
  };
  error?: string;
}

interface SeedApp {
  file: string;
  slug: string;
  type: string;
  draft: boolean;
}

interface Args {
  clusterId: string;
  token: string;
  baseUrl: string;
  resultsDir: string;
  only: string[] | null;
  exclude: string[];
  deep: string[];
  bulkEndpoint: 'none' | 'dns' | 'tls';
  certProvider: string;
  htmlCheck: boolean;
  allowMaster: boolean;
  timeoutMs: number;
  seedDir: string;
  includeDrafts: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const storage = new ConfigStorage(ProfileManager.getActiveProfile());

  const args: Args = {
    clusterId: process.env.FLUI_CLUSTER_ID ?? '',
    token: process.env.FLUI_API_KEY ?? storage.getApiKey() ?? '',
    baseUrl: process.env.FLUI_API_URL ?? storage.getApiUrl(),
    resultsDir: '',
    only: null,
    exclude: [],
    deep: DEFAULT_DEEP,
    bulkEndpoint: 'dns',
    certProvider: 'lets-encrypt-staging',
    htmlCheck: false,
    allowMaster: false,
    timeoutMs: 900_000,
    seedDir: DEFAULT_SEED_DIR,
    includeDrafts: false,
  };

  const list = (v: string): string[] =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--cluster':
        args.clusterId = argv[++i];
        break;
      case '--token':
        args.token = argv[++i];
        break;
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      case '--results-dir':
        args.resultsDir = argv[++i];
        break;
      case '--only':
        args.only = list(argv[++i]);
        break;
      case '--exclude':
        args.exclude = list(argv[++i]);
        break;
      case '--deep':
        args.deep = list(argv[++i]);
        break;
      case '--cert-provider':
        args.certProvider = argv[++i];
        break;
      case '--html-check':
        args.htmlCheck = true;
        break;
      case '--allow-master':
        args.allowMaster = true;
        break;
      case '--timeout':
        args.timeoutMs = parseInt(argv[++i], 10);
        break;
      case '--seed-dir':
        args.seedDir = argv[++i];
        break;
      case '--include-drafts':
        args.includeDrafts = true;
        break;
      case '--bulk-endpoint': {
        const v = argv[++i];
        if (v !== 'none' && v !== 'dns' && v !== 'tls') {
          log(`${RED}--bulk-endpoint must be none|dns|tls${RESET}`);
          process.exit(2);
        }
        args.bulkEndpoint = v;
        break;
      }
      default:
        log(`${RED}unknown option:${RESET} ${argv[i]}`);
        process.exit(2);
    }
  }

  if (!args.clusterId) {
    log(
      `${RED}error:${RESET} --cluster <id> required (or set FLUI_CLUSTER_ID)`,
    );
    process.exit(2);
  }
  if (!args.token) {
    log(
      `${RED}error:${RESET} no token — pass --token, set FLUI_API_KEY, or run 'flui auth:generate-api-key'`,
    );
    process.exit(2);
  }
  if (!args.resultsDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    args.resultsDir = join('runs', `catalog-${stamp}`);
  }
  return args;
}

function loadSeedApps(seedDir: string, includeDrafts: boolean): SeedApp[] {
  const dir = resolve(REPO_ROOT, seedDir);
  const files = readdirSync(dir).filter((f) => f.endsWith('.flui.yaml'));
  const apps: SeedApp[] = [];
  for (const f of files) {
    const full = join(dir, f);
    try {
      const doc = yaml.load(readFileSync(full, 'utf-8')) as {
        metadata?: { id?: string; draft?: boolean };
        spec?: { type?: string };
      };
      const slug = doc?.metadata?.id ?? f.replace('.flui.yaml', '');
      const draft = doc?.metadata?.draft ?? false;
      if (draft && !includeDrafts) continue;
      apps.push({
        file: full,
        slug,
        type: doc?.spec?.type ?? 'standalone',
        draft,
      });
    } catch (e) {
      log(
        `${YELLOW}warn:${RESET} could not parse ${f}: ${(e as Error).message}`,
      );
    }
  }
  // Building-blocks / standalone first, composed last (heavier, depend on more).
  const weight = (t: string): number =>
    t === 'composed' ? 2 : t === 'building-block' ? 0 : 1;
  apps.sort(
    (a, b) => weight(a.type) - weight(b.type) || a.slug.localeCompare(b.slug),
  );
  return apps;
}

function runSmokeTest(app: SeedApp, args: Args): Promise<SmokeResult> {
  const isDeep = args.deep.includes(app.slug);
  const flags = [
    SMOKE_SCRIPT,
    app.file,
    '--cluster',
    args.clusterId,
    '--token',
    args.token,
    '--base-url',
    args.baseUrl,
    '--capacity-gate',
    '--cleanup-wait',
    '--deps-mode',
    'dedicated',
    '--timeout',
    String(args.timeoutMs),
    '--json',
    '--results-dir',
    args.resultsDir,
  ];
  if (isDeep) {
    flags.push(
      '--endpoint',
      'tls',
      '--cert-provider',
      args.certProvider,
      '--deep',
    );
  } else {
    flags.push('--endpoint', args.bulkEndpoint);
    if (args.bulkEndpoint === 'tls')
      flags.push('--cert-provider', args.certProvider);
  }
  if (args.htmlCheck) flags.push('--html-check');
  if (args.allowMaster) flags.push('--allow-master');

  return new Promise<SmokeResult>((resolveResult) => {
    // stdout = JSON result (captured); stderr = live logs (inherited).
    const proc = spawn(
      'pnpm',
      ['exec', 'ts-node', '-r', 'tsconfig-paths/register', ...flags],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    proc.stdout.on(
      'data',
      (d: { toString(): string }) => (out += d.toString()),
    );
    const fallback = (
      status: SmokeResult['status'],
      error: string,
    ): SmokeResult => ({
      file: app.file,
      slug: app.slug,
      version: '?',
      status,
      durationMs: 0,
      error,
    });
    proc.on('error', (e: Error) =>
      resolveResult(fallback('ERROR', `spawn failed: ${e.message}`)),
    );
    proc.on('close', () => {
      // Prefer the per-app result file; fall back to parsing stdout JSON.
      const rFile = join(
        resolve(REPO_ROOT, args.resultsDir),
        `${app.slug}.json`,
      );
      try {
        if (existsSync(rFile)) {
          resolveResult(
            JSON.parse(readFileSync(rFile, 'utf-8')) as SmokeResult,
          );
          return;
        }
      } catch {
        /* fall through to stdout */
      }
      try {
        const start = out.indexOf('{');
        if (start >= 0) {
          resolveResult(JSON.parse(out.slice(start)) as SmokeResult);
          return;
        }
      } catch {
        /* ignore */
      }
      resolveResult(fallback('ERROR', 'no parseable result'));
    });
  });
}

function deepCell(r: SmokeResult): string {
  if (!r.deep) return '-';
  const mark = (op?: DeepOpResult): string =>
    !op ? '·' : op.skipped ? '–' : op.passed ? '✓' : '✗';
  return `rz${mark(r.deep.resize)} bk${mark(r.deep.backup)} tn${mark(r.deep.tunnel)}`;
}

function statusColor(s: string): string {
  if (s === 'RUNNING' || s === 'dry-run-ok') return GREEN;
  if (s === 'SKIPPED') return YELLOW;
  return RED;
}

function pad(s: string, n: number): string {
  // Pad ignoring ANSI; strip then re-measure visible length.
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, n - visible.length));
}

function printMatrix(results: SmokeResult[]): void {
  log('');
  log(
    `${BOLD}── Catalog validation matrix ──────────────────────────────${RESET}`,
  );
  log(
    `${BOLD}${pad('SLUG', 22)}${pad('INSTALL', 12)}${pad('HTML', 26)}${pad('ENDPOINT', 10)}${pad('DEEP', 16)}${RESET}`,
  );
  for (const r of results) {
    const install = `${statusColor(r.status)}${r.status}${RESET}`;
    let html = `${DIM}-${RESET}`;
    if (r.endpointHtml) {
      const h = r.endpointHtml;
      const label = h.title
        ? `"${h.title.slice(0, 16)}"`
        : `HTTP ${h.status ?? '?'}`;
      html = h.reachable
        ? `${GREEN}${label}${RESET}`
        : `${RED}unreachable${RESET}`;
    }
    const ep =
      r.endpointVerification && r.endpointVerification.length > 0
        ? r.endpointVerification.every((e) => e.passed)
          ? `${GREEN}ok${RESET}`
          : `${YELLOW}part${RESET}`
        : `${DIM}-${RESET}`;
    log(
      `${pad(r.slug, 22)}${pad(install, 12)}${pad(html, 26)}${pad(ep, 10)}${pad(deepCell(r), 16)}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  let apps = loadSeedApps(args.seedDir, args.includeDrafts);
  if (args.only) apps = apps.filter((a) => args.only!.includes(a.slug));
  if (args.exclude.length)
    apps = apps.filter((a) => !args.exclude.includes(a.slug));

  mkdirSync(resolve(REPO_ROOT, args.resultsDir), { recursive: true });

  log(`${CYAN}[PLAN]${RESET} ${apps.length} app(s) → ${args.resultsDir}`);
  log(
    `${CYAN}[PLAN]${RESET} bulk endpoint=${args.bulkEndpoint}; deep=[${args.deep.join(', ')}] cert=${args.certProvider}`,
  );
  log(`${CYAN}[PLAN]${RESET} order: ${apps.map((a) => a.slug).join(' → ')}`);

  const results: SmokeResult[] = [];
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const tag = args.deep.includes(app.slug) ? `${BOLD}(deep)${RESET}` : '';
    log('');
    log(
      `${CYAN}[${i + 1}/${apps.length}]${RESET} ${BOLD}${app.slug}${RESET} ${DIM}(${app.type})${RESET} ${tag}`,
    );
    const r = await runSmokeTest(app, args);
    results.push(r);
    log(
      `${CYAN}[${i + 1}/${apps.length}]${RESET} ${app.slug} → ${statusColor(r.status)}${r.status}${RESET}${r.error ? ` (${r.error})` : ''}`,
    );
  }

  printMatrix(results);

  const failed = results.filter(
    (r) =>
      r.status === 'FAILED' || r.status === 'TIMEOUT' || r.status === 'ERROR',
  );
  const skipped = results.filter((r) => r.status === 'SKIPPED');
  const running = results.filter((r) => r.status === 'RUNNING');

  const summary = {
    total: results.length,
    running: running.length,
    skipped: skipped.length,
    failed: failed.length,
    failedSlugs: failed.map((r) => r.slug),
    skippedSlugs: skipped.map((r) => r.slug),
    results,
  };
  writeFileSync(
    join(resolve(REPO_ROOT, args.resultsDir), 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
    'utf-8',
  );

  log('');
  log(
    `${BOLD}Summary:${RESET} ${GREEN}${running.length} running${RESET}, ${YELLOW}${skipped.length} skipped${RESET}, ${RED}${failed.length} failed${RESET} → ${args.resultsDir}/summary.json`,
  );
  if (failed.length) {
    log(`${RED}Failed:${RESET} ${failed.map((r) => r.slug).join(', ')}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  log(`${RED}fatal:${RESET} ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
