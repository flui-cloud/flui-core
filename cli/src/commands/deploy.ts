import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ApiClient } from '../lib/api-client';

interface LocalValidation {
  valid: boolean;
  kind: string;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

interface ManifestCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  title: string;
  detail: string;
}

/** Either the installation answered, or it says why it did not. */
type InstallationValidation =
  | { checks: ManifestCheck[]; wouldDeploy: boolean }
  | { skipped: string };
import { ConfigStorage } from '../lib/config-storage';
import { resolveClusterRef } from '../lib/resolve-cluster';
import { detectFrameworkFromProject } from '../lib/framework-detector';
import { runFrameworkPostChecks } from '../lib/framework-postchecks';
import { validate, parseYaml } from '@flui-cloud/spec';
import { DeployOverrides } from '../../../src/modules/applications/utils/deploy-overrides.util';

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
    'Supports both kind:CatalogApp (pre-built image) and kind:Application (source build via GitHub Actions). ' +
    'Author a manifest with `flui app init <framework>`; see every field with `flui app manifest`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> ./apps/api/flui.yaml',
    '<%= config.bin %> <%= command.id %> --repo acme/my-app --branch main',
    '<%= config.bin %> <%= command.id %> --detach',
    '<%= config.bin %> <%= command.id %> --env DATABASE_URL=postgres://... --env API_KEY=secret',
    '<%= config.bin %> <%= command.id %> --env-file .env --secret DATABASE_URL --secret API_KEY',
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
        'Release name override (default: metadata.name from the manifest). ' +
        'Part of the app identity, so passing a new one installs the same repo ' +
        'and branch a second time instead of updating the first install. ' +
        'Pass it on every deploy that targets that install.',
    }),
    exposure: Flags.string({
      description:
        'Override deploy.exposure for this install: public (Ingress + TLS) or ' +
        'internal (private URL behind Flui authentication).',
      options: ['public', 'internal'],
    }),
    env: Flags.string({
      char: 'e',
      description:
        'Environment variable override in KEY=VALUE format. Repeatable.',
      multiple: true,
    }),
    'env-file': Flags.string({
      description:
        'Path to a KEY=VALUE file of env overrides (one per line, # comments and ' +
        'blank lines ignored). Values never appear in the process arguments, so ' +
        'this is the safe way to pass secrets. --env entries take precedence. ' +
        'Name a key with --secret to also mark it as one.',
    }),
    secret: Flags.string({
      description:
        'Mark a key from --env/--env-file as a secret (repeatable): stored ' +
        'encrypted and delivered as a Kubernetes Secret rather than a plain ' +
        'ConfigMap entry, and never printed by `app status -o json` or ' +
        '`app env list`. Without this, every --env/--env-file value is stored ' +
        'as plain text — including one that looks like a credential.',
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
      description: 'Skip DNS and TLS provisioning for this install',
      default: false,
    }),
    'no-tls': Flags.boolean({
      description:
        "Provision the endpoint with DNS only, without a per-app TLS certificate. Overrides the manifest domain.tls. Avoids Let's Encrypt rate limits; the app is served over HTTP.",
      default: false,
    }),
    'cert-challenge': Flags.string({
      description:
        'ACME challenge for the app endpoint. http-01 works without a DNS zone and forces a per-host cert; dns-01 needs a cluster DNS zone with a wildcard issuer. Default: derived from cluster config.',
      options: ['http-01', 'dns-01'],
    }),
    'cert-provider': Flags.string({
      description:
        'Certificate issuer for the app endpoint. Default: cluster default.',
      options: ['lets-encrypt', 'lets-encrypt-staging'],
    }),
    hostname: Flags.string({
      description:
        'How the app is exposed: ip (nip.io) or domain (cluster DNS zone). Default: derived from manifest/cluster.',
      options: ['ip', 'domain'],
    }),
    'no-wait': Flags.boolean({
      description: 'Alias for --detach (kind:CatalogApp compat)',
      default: false,
    }),
    'validate-only': Flags.boolean({
      description:
        'Validate the manifest locally against the flui.cloud/v1beta1 schema without deploying (no cluster or login needed). Combine with --json for machine-readable output.',
      default: false,
    }),
    json: Flags.boolean({
      description:
        'With --validate-only, emit the result as JSON: { valid, kind, errors[], warnings[] }.',
      default: false,
    }),
    'skip-checks': Flags.boolean({
      description:
        'Bypass the framework post-checks (e.g. Next.js standalone output). ' +
        'Only use when you are certain the Dockerfile will succeed despite the warnings.',
      default: false,
    }),
    'allow-master': Flags.boolean({
      description:
        'Allow dedicated (node-local) storage to be placed on the control-plane node ' +
        'when the cluster has no worker. Escape hatch for single-node clusters (kind:CatalogApp).',
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
      if (!args.file) {
        const found = findManifestsBelow(process.cwd());
        if (found.length > 0) {
          this.error(
            `No flui.yaml in the current directory, but found ${found.length} manifest${found.length === 1 ? '' : 's'} in subdirectories:\n` +
              found.map((f) => `  • flui deploy ${f}`).join('\n') +
              `\n  Each flui.yaml is an independently deployable app — pass the one to deploy.`,
            { exit: 1 },
          );
        }
      }
      this.error(
        `Manifest not found: ${filePath}\n  Scaffold one with \`flui app init <framework>\` (run \`flui app init --list\` for the supported frameworks).`,
        { exit: 1 },
      );
    }

    const raw = fs.readFileSync(filePath, 'utf-8');

    // Validation is local-first (the bundled @flui-cloud/spec is the same schema
    // the server validates against) — no cluster or login required.
    if (flags['validate-only']) {
      await this.validateOnly(raw, flags, filePath);
      return;
    }

    const configStorage = new ConfigStorage();
    const apiUrl = flags['api-url'] ?? configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }

    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey: apiKey });

    // Detect manifest kind
    const kind = this.detectKind(raw);

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
    let resolved: Awaited<ReturnType<typeof resolveClusterRef>>;
    try {
      resolved = await resolveClusterRef(flags.cluster as string | undefined);
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

    const envOverrides = this.buildEnvOverrides(flags);
    const secretEnvKeys = this.resolveSecretEnvKeys(flags, envOverrides);
    const overrides = this.buildDeployOverrides(flags);

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
      secretEnvKeys,
      overrides,
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
          ...(secretEnvKeys.length > 0 ? { secretEnvKeys } : {}),
          ...(overrides ? { overrides } : {}),
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
    let resolved: Awaited<ReturnType<typeof resolveClusterRef>>;
    try {
      resolved = await resolveClusterRef(flags.cluster as string | undefined);
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }
    const { id: clusterId, name: clusterName } = resolved;

    const envOverrides = this.buildEnvOverrides(flags);

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
          ...(flags['allow-master'] ? { allowMasterPlacement: true } : {}),
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

  /**
   * Validate a manifest locally against the bundled @flui-cloud/spec schema —
   * the same schema (and semantic checks) the server enforces. Covers both
   * kind:Application and kind:CatalogApp. The server remains the final authority
   * at actual deploy time.
   */
  private validateManifestLocal(raw: string): LocalValidation {
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        kind: 'unknown',
        errors: [{ path: '<root>', message: `Invalid YAML: ${message}` }],
        warnings: [],
      };
    }

    const kind =
      typeof (parsed as { kind?: unknown })?.kind === 'string'
        ? (parsed as { kind: string }).kind
        : 'unknown';
    const result = validate(parsed);
    return {
      valid: result.valid,
      kind,
      errors: result.valid ? [] : result.errors,
      warnings: result.valid ? result.warnings : [],
    };
  }

  /**
   * The schema first, then the installation — and the second half is allowed to
   * be missing.
   *
   * The schema pass needs nothing: no cluster, no login, no network. That is the
   * whole reason it exists, and it stays true. What it cannot answer is whether
   * the manifest would land *here*, so when there is an installation to ask, it
   * is asked, and when there is not the output says which half ran rather than
   * implying the manifest was fully checked.
   */
  private async validateOnly(
    raw: string,
    flags: Record<string, unknown>,
    filePath: string,
  ): Promise<void> {
    const local = this.validateManifestLocal(raw);
    const installation =
      local.valid && local.kind === 'Application'
        ? await this.askInstallation(raw, flags, filePath)
        : { skipped: 'the manifest has to pass the schema first' };
    this.emitValidation(local, flags.json as boolean, installation);
  }

  /** Never throws: a validation that cannot reach the installation still has an answer. */
  private async askInstallation(
    raw: string,
    flags: Record<string, unknown>,
    filePath: string,
  ): Promise<InstallationValidation> {
    const configStorage = new ConfigStorage();
    const apiUrl =
      (flags['api-url'] as string | undefined) ?? configStorage.getApiUrl();
    const apiKey = configStorage.getApiKey();
    if (!apiUrl || !apiKey) {
      return {
        skipped:
          'not signed in — the schema was checked, the installation was not (`flui auth login`)',
      };
    }

    let clusterId: string;
    try {
      clusterId = (await resolveClusterRef(flags.cluster as string | undefined))
        .id;
    } catch {
      return {
        skipped:
          'no cluster to check against — name one with --cluster to have this installation weigh the manifest',
      };
    }

    const repoFullName =
      (flags.repo as string | undefined) ??
      this.detectGitRemote(path.dirname(filePath));

    try {
      const answer = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).post<{ checks?: ManifestCheck[]; wouldDeploy?: boolean }>(
        // Its own route, and a read permission: checking a manifest writes
        // nothing, and someone who may only read should not be refused it.
        '/applications/manifest/validate',
        {
          yaml: raw,
          clusterId,
          repoFullName,
          branch: (flags.branch as string | undefined) ?? 'main',
        },
      );
      return {
        checks: answer.checks ?? [],
        wouldDeploy: answer.wouldDeploy ?? true,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { skipped: `the installation could not be reached — ${message}` };
    }
  }

  private emitValidation(
    r: LocalValidation,
    asJson: boolean,
    installation: InstallationValidation,
  ): void {
    if (asJson) {
      this.log(JSON.stringify({ ...r, installation }, null, 2));
      if (!r.valid) this.exit(1);
      return;
    }

    if (r.valid) {
      console.log(chalk.green(`\n  Manifest is valid (kind: ${r.kind})\n`));
      for (const w of r.warnings) {
        console.log(chalk.yellow(`  ⚠ ${w.path}: ${w.message}`));
      }
      if (r.warnings.length) {
        console.log(
          chalk.dim(
            '\n  (warnings = spec-accepted fields not yet applied on source deploys)\n',
          ),
        );
      }
      this.printInstallation(installation);
      return;
    }

    console.log(chalk.red('\n  Manifest has errors:\n'));
    for (const e of r.errors) {
      console.log(chalk.red(`    • ${e.path}: ${e.message}`));
    }
    console.log('');
    this.exit(1);
  }

  /**
   * The half a schema cannot answer. A skipped check is stated, not omitted:
   * silence here reads as "everything was checked", which is the one thing this
   * output must never imply.
   */
  private printInstallation(installation: InstallationValidation): void {
    if ('skipped' in installation) {
      console.log(
        chalk.dim(`  Installation checks skipped: ${installation.skipped}\n`),
      );
      return;
    }

    console.log(chalk.bold('  Against this installation:\n'));
    for (const check of installation.checks) {
      const mark = {
        pass: chalk.green('  ✓'),
        warn: chalk.yellow('  ⚠'),
        fail: chalk.red('  ✗'),
        unknown: chalk.dim('  ?'),
      }[check.status];
      console.log(`${mark} ${check.title} — ${check.detail}`);
    }
    console.log(
      installation.wouldDeploy
        ? chalk.green('\n  Nothing here would stop a deploy.\n')
        : chalk.red('\n  This would not deploy as it stands.\n'),
    );
    if (!installation.wouldDeploy) this.exit(1);
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

  /**
   * Merge env overrides from --env-file (if given) and --env, with --env
   * winning. File values stay off the process argument list, so secrets passed
   * this way never leak into `ps` output or shell history.
   */
  private buildEnvOverrides(
    flags: Record<string, unknown>,
  ): Record<string, string> {
    const fromFile = this.parseEnvFile(flags['env-file'] as string | undefined);
    const fromArgs = this.parseEnvOverrides(
      (flags.env as string[] | undefined) ?? [],
    );
    return { ...fromFile, ...fromArgs };
  }

  private parseEnvFile(filePath?: string): Record<string, string> {
    if (!filePath) return {};
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      this.error(`Cannot read --env-file "${filePath}".`, { exit: 1 });
    }
    const result: Record<string, string> = {};
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) {
        this.error(
          `Invalid line ${i + 1} in --env-file "${filePath}": expected KEY=VALUE.`,
          { exit: 1 },
        );
      }
      result[line.slice(0, eq).trim()] = line.slice(eq + 1);
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
    secretEnvKeys: string[];
    overrides?: DeployOverrides;
  }): void {
    console.log(chalk.cyan('\n  Deploy from source\n'));
    console.log(`  ${chalk.bold('File:')}    ${opts.filePath}`);
    console.log(`  ${chalk.bold('Cluster:')} ${opts.clusterName}`);
    console.log(`  ${chalk.bold('Repo:')}    ${opts.repoFullName}`);
    console.log(`  ${chalk.bold('Branch:')}  ${opts.branch}`);
    if (opts.overrides?.name) {
      console.log(`  ${chalk.bold('Name:')}    ${opts.overrides.name}`);
    }
    if (opts.overrides?.domain?.fqdn) {
      console.log(`  ${chalk.bold('Domain:')}  ${opts.overrides.domain.fqdn}`);
    }
    if (opts.overrides?.exposure) {
      console.log(`  ${chalk.bold('Expose:')}  ${opts.overrides.exposure}`);
    }
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
      const plainKeys = envKeys.filter((k) => !opts.secretEnvKeys.includes(k));
      const parts = [
        ...plainKeys,
        ...opts.secretEnvKeys.map((k) => chalk.yellow(`${k} (secret)`)),
      ];
      console.log(`  ${chalk.bold('Env:')}     ${parts.join(', ')}`);
    }
    const unmarkedLookLikeCredentials = envKeys.filter(
      (k) =>
        !opts.secretEnvKeys.includes(k) && this.looksLikeACredentialName(k),
    );
    if (unmarkedLookLikeCredentials.length > 0) {
      const plural = unmarkedLookLikeCredentials.length > 1;
      console.log(
        `  ${chalk.yellow('⚠')}  ${unmarkedLookLikeCredentials.join(', ')} ` +
          `${plural ? 'look' : 'looks'} like ${plural ? 'credentials' : 'a credential'} but ` +
          `${plural ? "aren't" : "isn't"} marked --secret — ` +
          `${plural ? 'they' : 'it'} will be stored and shown in plain text.`,
      );
    }
    console.log('');
  }

  /**
   * A soft nudge, not a gate: named after the same shape the manifest's own
   * `secret`/`sensitive` fields warn about, so a plain KEY=VALUE deploy of a
   * real credential doesn't sail through silently just because nobody typed
   * --secret. Never blocks the deploy — the author may have a real reason.
   */
  private looksLikeACredentialName(key: string): boolean {
    return /(SECRET|PASSWORD|TOKEN|_KEY|API_KEY|PRIVATE)/i.test(key);
  }

  /**
   * `--secret KEY` only makes sense for a key actually being deployed this
   * time — refusing a typo here beats silently deploying the credential in
   * plain text because the name didn't match.
   */
  private resolveSecretEnvKeys(
    flags: Record<string, unknown>,
    envOverrides: Record<string, string>,
  ): string[] {
    const keys = (flags.secret as string[] | undefined) ?? [];
    const unknown = keys.filter((k) => !(k in envOverrides));
    if (unknown.length > 0) {
      this.error(
        `--secret named ${unknown.join(', ')}, but --env/--env-file don't declare ${
          unknown.length > 1 ? 'them' : 'it'
        }. Pass the value with --env/--env-file too, or drop --secret for ${
          unknown.length > 1 ? 'these keys' : 'this key'
        }.`,
        { exit: 1 },
      );
    }
    return keys;
  }

  /**
   * Install-time overrides of manifest fields, from the endpoint flags. They
   * are what lets one repo and branch be installed more than once: the name and
   * the domain cannot both live in the file the two installs share.
   */
  private buildDeployOverrides(
    flags: Record<string, unknown>,
  ): DeployOverrides | undefined {
    const domain: DeployOverrides['domain'] = {
      ...(flags.domain ? { fqdn: flags.domain as string } : {}),
      ...(flags['no-tls'] ? { tls: false } : {}),
      ...(flags['cert-challenge']
        ? { certChallenge: flags['cert-challenge'] as 'http-01' | 'dns-01' }
        : {}),
      ...(flags['cert-provider']
        ? {
            certificateProvider: flags['cert-provider'] as
              | 'lets-encrypt'
              | 'lets-encrypt-staging',
          }
        : {}),
      ...(flags.hostname
        ? { hostnameMode: flags.hostname as 'ip' | 'domain' }
        : {}),
      ...(flags['skip-endpoint'] ? { auto: false } : {}),
    };

    const overrides: DeployOverrides = {
      ...(flags.name ? { name: flags.name as string } : {}),
      ...(flags.exposure
        ? { exposure: flags.exposure as 'public' | 'internal' }
        : {}),
      ...(Object.keys(domain).length > 0 ? { domain } : {}),
    };

    return Object.keys(overrides).length > 0 ? overrides : undefined;
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

const MANIFEST_SCAN_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.cache',
]);

/** Find flui.yaml manifests in subdirectories (monorepo), up to 3 levels deep. */
function findManifestsBelow(
  root: string,
  dir = root,
  depth = 0,
  found: string[] = [],
): string[] {
  if (depth > 3 || found.length >= 10) return found;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'flui.yaml' && dir !== root) {
      found.push(path.relative(root, path.join(dir, entry.name)));
    } else if (
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      !MANIFEST_SCAN_SKIP.has(entry.name)
    ) {
      findManifestsBelow(root, path.join(dir, entry.name), depth + 1, found);
    }
  }
  return found;
}
