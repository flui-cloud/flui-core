import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ApiClient } from '../lib/api-client';
import { ConfigStorage } from '../lib/config-storage';
import { resolveCluster } from '../lib/resolve-cluster';
import { detectFrameworkFromProject } from '../lib/framework-detector';
import { runFrameworkPostChecks } from '../lib/framework-postchecks';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_CATALOG_MS = 600_000; // 10 min for catalog installs
const MAX_WAIT_SOURCE_MS = 2_100_000; // 35 min for source builds (GH Actions + deploy)

// ── Catalog install types ──────────────────────────────────────────────────

interface InstallResponse {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  operationId?: string;
  requestedDomain?: string;
  resolvedFqdn?: string;
  errorMessage?: string;
}

interface ValidateResponse {
  valid: boolean;
  errors?: string[];
  checksum?: string;
  manifest?: unknown;
}

// ── Source deploy types ────────────────────────────────────────────────────

interface SourceDeployResponse {
  applicationId: string;
  slug: string;
  name: string;
  status: string;
  workflowUrl?: string;
  workflowRunUrl?: string;
}

interface ApplicationStatusResponse {
  id: string;
  slug: string;
  name: string;
  status: string;
  lastBuildStatus?: string;
  lastBuildConclusion?: string;
  workflowRunUrl?: string;
  reconciliationError?: string;
  resolvedFqdn?: string;
}

// ── CLI command ────────────────────────────────────────────────────────────

export default class Deploy extends Command {
  static readonly description =
    'Deploy an application from a flui.yaml manifest to a cluster. ' +
    'Supports both kind:CatalogApp (pre-built image) and kind:Application (source build via GitHub Actions).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> ./apps/api/flui.yaml',
    '<%= config.bin %> <%= command.id %> --repo acme/my-app --branch main',
    '<%= config.bin %> <%= command.id %> --detach',
    '<%= config.bin %> <%= command.id %> --env DATABASE_URL=postgres://... --env API_KEY=secret',
    '<%= config.bin %> <%= command.id %> --validate-only',
    '<%= config.bin %> <%= command.id %> --cluster my-cluster',
  ];

  static readonly args = {
    file: Args.string({
      description: 'Path to flui.yaml manifest (default: ./flui.yaml)',
      required: false,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Target cluster name or ID (default: auto-detect)',
    }),
    repo: Flags.string({
      char: 'r',
      description:
        'GitHub repository full name owner/repo (default: auto-detect from git remote origin). Required for kind:Application.',
    }),
    branch: Flags.string({
      char: 'b',
      description:
        'Git branch to deploy (default: auto-detect current branch). Used for kind:Application.',
    }),
    domain: Flags.string({
      char: 'd',
      description:
        'Custom FQDN for the app (default: auto-assign from cluster DNS zone)',
    }),
    name: Flags.string({
      description:
        'Display name override (default: metadata.name from manifest)',
    }),
    env: Flags.string({
      char: 'e',
      description:
        'Environment variable override in KEY=VALUE format. Repeatable.',
      multiple: true,
    }),
    detach: Flags.boolean({
      description:
        'Return immediately after triggering the build/deploy without waiting for completion. ' +
        'Use `flui app status <name>` to track progress.',
      default: false,
    }),
    'no-build': Flags.boolean({
      description:
        'Skip the GitHub Actions build and re-deploy the current image. ' +
        'Useful for fast iterations on flui.yaml config (env, ports, healthcheck, endpoint) without rebuilding. ' +
        'If the app was deleted, falls back to the GHCR latest tag for {owner}/{repoName}.',
      default: false,
    }),
    image: Flags.string({
      description:
        'Deploy a specific image reference (e.g. ghcr.io/owner/repo:sha). ' +
        'Skips the build pipeline. Useful for rollback to a known tag, or to deploy from GHCR ' +
        'when the app was deleted from Flui.',
    }),
    'skip-endpoint': Flags.boolean({
      description: 'Skip DNS and TLS provisioning (kind:CatalogApp only)',
      default: false,
    }),
    'no-tls': Flags.boolean({
      description:
        "Provision the endpoint with DNS only, without a per-app TLS certificate (kind:CatalogApp). Overrides the manifest domain.tls. Avoids Let's Encrypt rate limits; the app is served over HTTP.",
      default: false,
    }),
    'cert-challenge': Flags.string({
      description:
        'ACME challenge for the app endpoint (kind:CatalogApp). http-01 works without a DNS zone and forces a per-host cert; dns-01 needs a cluster DNS zone with a wildcard issuer. Default: derived from cluster config.',
      options: ['http-01', 'dns-01'],
    }),
    'cert-provider': Flags.string({
      description:
        'Certificate issuer for the app endpoint (kind:CatalogApp). Default: cluster default.',
      options: ['lets-encrypt', 'lets-encrypt-staging'],
    }),
    hostname: Flags.string({
      description:
        'How the app is exposed (kind:CatalogApp): ip (nip.io) or domain (cluster DNS zone). Default: derived from manifest/cluster.',
      options: ['ip', 'domain'],
    }),
    'no-wait': Flags.boolean({
      description: 'Alias for --detach (kind:CatalogApp compat)',
      default: false,
    }),
    'validate-only': Flags.boolean({
      description:
        'Validate manifest against the flui/v1 schema without deploying',
      default: false,
    }),
    'skip-checks': Flags.boolean({
      description:
        'Bypass the framework post-checks (e.g. Next.js standalone output). ' +
        'Only use when you are certain the Dockerfile will succeed despite the warnings.',
      default: false,
    }),
    'api-url': Flags.string({
      description:
        'Override the API base URL (e.g. http://localhost:3000/api/v1) for local-API testing against an unreleased backend. Default: active profile.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Deploy);

    const filePath = path.resolve(args.file ?? 'flui.yaml');
    if (!fs.existsSync(filePath)) {
      this.error(
        `Manifest not found: ${filePath}\n  Create one with \`flui init\` or point to an existing file.`,
        { exit: 1 },
      );
    }

    const raw = fs.readFileSync(filePath, 'utf-8');

    const configStorage = new ConfigStorage();
    const apiUrl = flags['api-url'] ?? configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }

    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey: apiKey });

    // Detect manifest kind
    const kind = this.detectKind(raw);

    if (flags['validate-only']) {
      await this.validateManifest(apiClient, raw);
      return;
    }

    if (kind === 'Application') {
      await this.runSourceDeploy(apiClient, raw, flags, filePath);
    } else {
      await this.runCatalogDeploy(apiClient, raw, flags);
    }
  }

  // ── Source deploy (kind: Application) ─────────────────────────────────────

  private async runSourceDeploy(
    apiClient: ApiClient,
    raw: string,
    flags: Record<string, unknown>,
    filePath: string,
  ): Promise<void> {
    let resolved: Awaited<ReturnType<typeof resolveCluster>>;
    try {
      resolved = await resolveCluster(flags.cluster as string | undefined);
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }
    const { id: clusterId, name: clusterName } = resolved;

    const repoFullName =
      (flags.repo as string | undefined) ??
      this.detectGitRemote(path.dirname(filePath));
    if (!repoFullName) {
      this.error(
        'Could not detect GitHub repository. ' +
          'Provide it with --repo owner/repo or run from inside a git repository with a remote named "origin".',
        { exit: 1 },
      );
    }

    const branch =
      (flags.branch as string | undefined) ??
      this.detectGitBranch(path.dirname(filePath)) ??
      'main';

    const envOverrides = this.parseEnvOverrides(
      (flags.env as string[] | undefined) ?? [],
    );

    const skipBuild = (flags['no-build'] as boolean) || !!flags.image;
    const explicitImage = flags.image as string | undefined;

    if (!skipBuild && !explicitImage) {
      const blocked = this.runPostChecksOrBail(
        path.dirname(filePath),
        flags['skip-checks'] as boolean,
      );
      if (blocked) return;
    }

    this.printDeployHeader({
      filePath,
      clusterName,
      repoFullName,
      branch,
      explicitImage,
      skipBuild,
      envOverrides,
    });

    let spinnerLabel: string;
    if (explicitImage) {
      spinnerLabel = `Deploying ${explicitImage}…`;
    } else if (skipBuild) {
      spinnerLabel = 'Re-deploying current image…';
    } else {
      spinnerLabel = 'Submitting manifest…';
    }
    const spinner = ora(spinnerLabel).start();

    let deploy: SourceDeployResponse;
    try {
      deploy = await apiClient.post<SourceDeployResponse>(
        '/applications/deploy-from-yaml',
        {
          yaml: raw,
          clusterId,
          repoFullName,
          branch,
          skipBuild,
          ...(explicitImage ? { imageRef: explicitImage } : {}),
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        },
      );
      spinner.succeed(
        skipBuild ? 'Deploy triggered (build skipped)' : 'Build triggered',
      );
    } catch (error: unknown) {
      spinner.fail('Failed to trigger deploy');
      const msg =
        (error as any).response?.data?.message ?? (error as Error).message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      if (/GitHub integration is not connected/i.test(msg)) {
        console.log(
          chalk.yellow(
            '  Hint: run `flui integration connect github` to install the Flui GitHub App.\n',
          ),
        );
      } else if (/GHCR PAT/i.test(msg)) {
        console.log(
          chalk.yellow(
            '  Hint: run `flui integration ghcr-pat set` to add a GitHub PAT with read:packages scope.\n',
          ),
        );
      } else if (/Repository .* is not connected/i.test(msg)) {
        console.log(
          chalk.yellow(
            `  Hint: run \`flui repo connect ${repoFullName}\` to import this repository into Flui.\n`,
          ),
        );
      }
      this.exit(1);
    }

    console.log('');
    console.log(`  ${chalk.bold('App:')}    ${deploy.name} (${deploy.slug})`);
    if (deploy.workflowUrl) {
      console.log(
        `  ${chalk.bold('Workflow:')} ${chalk.dim(deploy.workflowUrl)}`,
      );
    }
    console.log('');

    const detach = (flags.detach as boolean) || (flags['no-wait'] as boolean);

    if (detach) {
      if (deploy.workflowRunUrl) {
        console.log(
          `  ${chalk.bold('Build:')} ${chalk.cyan(deploy.workflowRunUrl)}`,
        );
      }
      console.log(
        chalk.dim(`  Track progress:  flui app status ${deploy.slug}\n`),
      );
      return;
    }

    await this.pollSourceDeploy(apiClient, deploy);
  }

  private async pollSourceDeploy(
    apiClient: ApiClient,
    deploy: SourceDeployResponse,
  ): Promise<void> {
    console.log(
      chalk.dim(
        `  Waiting for build + deploy to complete (up to ${MAX_WAIT_SOURCE_MS / 60000} min)…`,
      ),
    );
    const spinner = ora('Waiting for GitHub Actions build…').start();
    const started = Date.now();
    let lastPhase = '';

    while (Date.now() - started < MAX_WAIT_SOURCE_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const done = await this.pollSourceDeployTick(
        apiClient,
        deploy,
        spinner,
        started,
        lastPhase,
      );
      if (done.finished) {
        if (done.failed) this.exit(1);
        return;
      }
      lastPhase = done.lastPhase;
    }

    spinner.warn('Timed out waiting for build + deploy');
    console.log(chalk.yellow(`\n  Still in progress. Track with:`));
    console.log(chalk.dim(`    flui app status ${deploy.slug}\n`));
  }

  private async pollSourceDeployTick(
    apiClient: ApiClient,
    deploy: SourceDeployResponse,
    spinner: ReturnType<typeof ora>,
    started: number,
    lastPhase: string,
  ): Promise<{ finished: boolean; lastPhase: string; failed?: boolean }> {
    try {
      const app = await apiClient.get<ApplicationStatusResponse>(
        `/applications/${deploy.applicationId}`,
      );
      const elapsed = Math.floor((Date.now() - started) / 1000);
      const phase = this.resolvePhase(app);

      if (this.isRunningStatus(app.status)) {
        spinner.succeed(chalk.green(`"${deploy.name}" is live`));
        console.log('');
        if (app.resolvedFqdn) {
          const url = chalk.cyan(`https://${app.resolvedFqdn}`);
          console.log(`  ${chalk.bold('URL:')} ${url}`);
        }
        console.log(
          chalk.dim(`  Run \`flui app status ${deploy.slug}\` for details.\n`),
        );
        return { finished: true, lastPhase: phase };
      }

      if (this.isFailedStatus(app.status)) {
        spinner.fail('Deploy failed');
        const msg = app.reconciliationError ?? 'Unknown error';
        console.log(chalk.red(`\n  Error: ${msg}\n`));
        if (app.workflowRunUrl) {
          console.log(chalk.dim(`  Build logs: ${app.workflowRunUrl}\n`));
        }
        return { finished: true, lastPhase: phase, failed: true };
      }

      const buildHint =
        app.workflowRunUrl && this.isAwaitingBuildStatus(app.status)
          ? chalk.dim(` → ${app.workflowRunUrl}`)
          : '';
      spinner.text = `${phase} [${elapsed}s]${buildHint}`;
      return { finished: false, lastPhase: phase };
    } catch {
      return { finished: false, lastPhase };
    }
  }

  private resolvePhase(app: ApplicationStatusResponse): string {
    const s = (app.status ?? '').toLowerCase();
    if (s === 'awaiting_build') {
      if (app.lastBuildStatus === 'in_progress')
        return 'Building image via GitHub Actions…';
      if (
        app.lastBuildStatus === 'completed' &&
        app.lastBuildConclusion !== 'success'
      ) {
        return 'Build completed — waiting for result…';
      }
      return 'Waiting for GitHub Actions build…';
    }
    if (s === 'provisioning') return 'Deploying to cluster…';
    if (s === 'updating') return 'Rolling out update…';
    return `${s}…`;
  }

  /**
   * The API serialises ApplicationStatus values as lowercase
   * (`running`, `failed`, `awaiting_build`, …). Compare normalised so that
   * historical uppercase strings — or future case drift — do not silently
   * keep the polling loop alive forever.
   */
  private isRunningStatus(s: string | undefined): boolean {
    return (s ?? '').toLowerCase() === 'running';
  }

  private isFailedStatus(s: string | undefined): boolean {
    return (s ?? '').toLowerCase() === 'failed';
  }

  private isAwaitingBuildStatus(s: string | undefined): boolean {
    return (s ?? '').toLowerCase() === 'awaiting_build';
  }

  // ── Catalog deploy (kind: CatalogApp) ─────────────────────────────────────

  private async runCatalogDeploy(
    apiClient: ApiClient,
    yaml: string,
    flags: Record<string, unknown>,
  ): Promise<void> {
    let resolved: Awaited<ReturnType<typeof resolveCluster>>;
    try {
      resolved = await resolveCluster(flags.cluster as string | undefined);
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }
    const { id: clusterId, name: clusterName } = resolved;

    const envOverrides: Record<string, string> = {};
    for (const kv of (flags.env as string[] | undefined) ?? []) {
      const eq = kv.indexOf('=');
      if (eq < 1) {
        this.error(`Invalid --env value "${kv}". Expected KEY=VALUE format.`, {
          exit: 1,
        });
      }
      envOverrides[kv.slice(0, eq)] = kv.slice(eq + 1);
    }

    console.log(chalk.cyan('\n  Deploy from manifest\n'));
    console.log(`  ${chalk.bold('Cluster:')} ${clusterName}`);
    if (flags.domain)
      console.log(`  ${chalk.bold('Domain:')}  ${flags.domain as string}`);
    if (Object.keys(envOverrides).length > 0) {
      console.log(
        `  ${chalk.bold('Env:')}     ${Object.keys(envOverrides).join(', ')}`,
      );
    }
    console.log('');

    const spinner = ora('Submitting manifest…').start();

    let install: InstallResponse;
    try {
      install = await apiClient.post<InstallResponse>(
        '/catalog/install-from-yaml',
        {
          yaml,
          clusterId,
          ...(flags.name ? { displayName: flags.name as string } : {}),
          ...(flags.domain ? { domain: flags.domain as string } : {}),
          ...(flags['cert-challenge']
            ? { certChallenge: flags['cert-challenge'] as string }
            : {}),
          ...(flags['cert-provider']
            ? { certificateProvider: flags['cert-provider'] as string }
            : {}),
          ...(flags.hostname ? { hostnameMode: flags.hostname as string } : {}),
          ...(flags['skip-endpoint'] ? { skipEndpoint: true } : {}),
          ...(flags['no-tls'] ? { tls: false } : {}),
          ...(Object.keys(envOverrides).length > 0
            ? { envOverrides, userInputs: envOverrides }
            : {}),
        },
      );
      spinner.succeed('Install queued');
      console.log('');
      console.log(`  ${chalk.bold('Install ID:')}   ${install.id}`);
      console.log(
        `  ${chalk.bold('App:')}          ${install.displayName} (${install.slug})`,
      );
      if (install.operationId) {
        console.log(`  ${chalk.bold('Operation:')}    ${install.operationId}`);
      }
      console.log('');
    } catch (error: unknown) {
      spinner.fail('Failed to submit manifest');
      const msg =
        (error as any).response?.data?.message ?? (error as Error).message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      const serverErrors = (error as any).response?.data?.errors;
      if (Array.isArray(serverErrors)) {
        for (const e of serverErrors) {
          console.log(chalk.red(`    • ${e}`));
        }
        console.log('');
      }
      this.exit(1);
    }

    const noWait = (flags['no-wait'] as boolean) || (flags.detach as boolean);
    if (noWait) {
      console.log(
        chalk.dim(
          `  Use \`flui app status ${install.slug}\` to check progress.\n`,
        ),
      );
      return;
    }

    console.log(
      chalk.dim(
        `  Waiting for install to complete (up to ${MAX_WAIT_CATALOG_MS / 60000} min)…`,
      ),
    );
    const waitSpinner = ora(`Installing ${install.displayName}…`).start();
    const started = Date.now();

    while (Date.now() - started < MAX_WAIT_CATALOG_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      try {
        const current = await apiClient.get<InstallResponse>(
          `/catalog/installs/${install.id}`,
        );

        if (this.isRunningStatus(current.status)) {
          waitSpinner.succeed(
            chalk.green(`"${install.displayName}" is running`),
          );
          console.log('');
          if (current.resolvedFqdn) {
            const url = chalk.cyan(`https://${current.resolvedFqdn}`);
            console.log(`  ${chalk.bold('URL:')} ${url}`);
          }
          console.log(
            chalk.dim(
              `  Run \`flui app status ${install.slug}\` for runtime details.\n`,
            ),
          );
          return;
        }

        if (this.isFailedStatus(current.status)) {
          waitSpinner.fail('Install failed');
          const msg = current.errorMessage ?? 'Unknown error';
          console.log(chalk.red(`\n  Error: ${msg}\n`));
          this.exit(1);
        }

        waitSpinner.text = `Installing ${install.displayName}… (${(current.status ?? '').toLowerCase()})`;
      } catch {
        // polling error — keep trying
      }
    }

    waitSpinner.warn('Timed out waiting for install');
    console.log(chalk.yellow(`\n  Install is still in progress. Check with:`));
    console.log(chalk.dim(`    flui app status ${install.slug}\n`));
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  private async validateManifest(
    apiClient: ApiClient,
    raw: string,
  ): Promise<void> {
    const kind = this.detectKind(raw);

    if (kind === 'Application') {
      // Local validation — send to deploy-from-yaml with validateOnly flag
      const spinner = ora('Validating manifest…').start();
      try {
        await apiClient.post('/applications/deploy-from-yaml', {
          yaml: raw,
          clusterId: '00000000-0000-0000-0000-000000000000',
          repoFullName: 'validate/only',
          validateOnly: true,
        });
        spinner.stop();
        console.log(chalk.green('\n  Manifest is valid (kind: Application)\n'));
      } catch (error: unknown) {
        spinner.fail('Validation failed');
        const msg =
          (error as any).response?.data?.message ?? (error as Error).message;
        console.log(chalk.red(`\n  Error: ${msg}\n`));
        this.exit(1);
      }
      return;
    }

    const spinner = ora('Validating manifest…').start();
    try {
      const result = await apiClient.post<ValidateResponse>(
        '/catalog/validate',
        { yaml: raw },
      );
      spinner.stop();
      if (result.valid) {
        console.log(chalk.green('\n  Manifest is valid\n'));
        if (result.checksum) {
          console.log(chalk.dim(`  Checksum: ${result.checksum}\n`));
        }
      } else {
        console.log(chalk.red('\n  Manifest has errors:\n'));
        for (const err of result.errors ?? []) {
          console.log(chalk.red(`    • ${err}`));
        }
        console.log('');
        this.exit(1);
      }
    } catch (error: unknown) {
      spinner.fail('Validation failed');
      const msg =
        (error as any).response?.data?.message ?? (error as Error).message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Runs framework-specific pre-deploy checks against the project directory.
   * Returns `true` when the deploy should bail (warnings present, no override).
   */
  private runPostChecksOrBail(projectDir: string, skip: boolean): boolean {
    const detected = detectFrameworkFromProject(projectDir);
    if (!detected) return false;
    const issues = runFrameworkPostChecks(detected.framework, projectDir);
    const warnings = issues.filter((i) => i.level === 'warn');
    if (warnings.length === 0) return false;

    console.log('');
    for (const issue of warnings) {
      console.log(`  ${chalk.yellow('⚠')} ${chalk.bold(issue.title)}`);
      console.log(chalk.dim(`     ${issue.detail}`));
      for (const line of issue.hint.split('\n')) {
        console.log(chalk.dim(`     ${line}`));
      }
      console.log('');
    }

    if (skip) {
      console.log(
        chalk.dim('  --skip-checks set, proceeding despite warnings.\n'),
      );
      return false;
    }

    console.log(
      chalk.red(
        '  Refusing to deploy: framework post-checks failed. ' +
          'Fix the issues above, or re-run with --skip-checks to bypass.\n',
      ),
    );
    this.exit(1);
    return true;
  }

  private detectKind(raw: string): string {
    const match = /^kind:\s*(.+)$/m.exec(raw);
    return match?.[1]?.trim() ?? 'CatalogApp';
  }

  private parseEnvOverrides(entries: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const kv of entries) {
      const eq = kv.indexOf('=');
      if (eq < 1) {
        this.error(`Invalid --env value "${kv}". Expected KEY=VALUE format.`, {
          exit: 1,
        });
      }
      result[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return result;
  }

  private printDeployHeader(opts: {
    filePath: string;
    clusterName: string;
    repoFullName: string;
    branch: string;
    explicitImage?: string;
    skipBuild: boolean;
    envOverrides: Record<string, string>;
  }): void {
    console.log(chalk.cyan('\n  Deploy from source\n'));
    console.log(`  ${chalk.bold('File:')}    ${opts.filePath}`);
    console.log(`  ${chalk.bold('Cluster:')} ${opts.clusterName}`);
    console.log(`  ${chalk.bold('Repo:')}    ${opts.repoFullName}`);
    console.log(`  ${chalk.bold('Branch:')}  ${opts.branch}`);
    if (opts.explicitImage) {
      const mode = chalk.yellow(`--image ${opts.explicitImage}`);
      console.log(`  ${chalk.bold('Mode:')}    ${mode}`);
    } else if (opts.skipBuild) {
      console.log(
        `  ${chalk.bold('Mode:')}    ${chalk.yellow('--no-build (reuse latest image)')}`,
      );
    }
    const envKeys = Object.keys(opts.envOverrides);
    if (envKeys.length > 0) {
      console.log(`  ${chalk.bold('Env:')}     ${envKeys.join(', ')}`);
    }
    console.log('');
  }

  private detectGitRemote(cwd: string): string | undefined {
    try {
      const remote = execSync('git remote get-url origin', {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
      const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private detectGitBranch(cwd: string): string | undefined {
    try {
      const branch = execSync('git branch --show-current', {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }
}
