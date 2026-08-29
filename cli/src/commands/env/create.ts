import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { buildNipBaseDomain } from '../../lib/nip-base-domain.util';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { OperationStatus } from 'src/modules/infrastructure/servers/entities/infrastructure-operations.entity';
import { FirewallProviderFactory } from 'src/modules/providers/core/factories/firewall-provider.factory';
import { IpDetectionService } from '../../lib/utils/ip-detection';
import { CliFirewallRepository } from '../../lib/repositories/cli-firewall.repository';
import { CONTROL_FIREWALL_RULES } from '../../lib/templates/firewall-rules';
import { VnetProvisioningService } from '../../lib/services/vnet-provisioning.service';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { isCompoundProvider } from '../../lib/provider-credential-schemas';
import { printContextBanner } from '../../lib/context-banner';
import {
  getEffectiveRelease,
  formatReleaseOverrideBanner,
} from '../../config/release-override';
import { ServerTypeCacheService } from '../../services/server-type-cache.service';
import { ServerTypeValidatorService } from '../../services/server-type-validator.service';

import {
  getRecommendedServerType,
  getFallbackServerTypes,
  getEuRegions,
  getDefaultRegion,
} from '../../config/defaults';
import {
  confirmAlternativeServerType,
  displayServerTypeNotFoundError,
  selectServerTypePrompt,
  runProviderSetupWizard,
  selectConfiguredProvider,
  promptInput,
} from '../../lib/prompts';
import { PreferencesResolver } from '../../config/preferences-resolver';
import { refuseToAsk, setNonInteractive } from '../../lib/non-interactive';
import { emitEvent } from '../../lib/progress-events';
import { SshMode } from '../../lib/ssh-mode';
import { PREFERENCES } from '../../config/preferences-schema';
import { contextLabelPair, contextTag } from '../../lib/context-stamp';

export default class EnvCreate extends Command {
  static readonly description = 'Create control cluster infrastructure on K3s';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --node-size cx32',
    '<%= config.bin %> <%= command.id %> -d',
    '<%= config.bin %> <%= command.id %> --region fsn1',
    '<%= config.bin %> <%= command.id %> --wait',
  ];

  static readonly flags = {
    provider: Flags.string({
      char: 'p',
      description:
        "Cloud provider for the control cluster (default: the profile's configured provider)",
      options: ['hetzner', 'scaleway'],
    }),
    'node-size': Flags.string({
      description:
        'Server type for cluster nodes (run "flui server-types list --provider <provider>" to see available types). Defaults to the provider recommended size.',
    }),
    region: Flags.string({
      char: 'r',
      description:
        'Region/location code. Defaults to the provider default region.',
    }),
    'node-count': Flags.integer({
      description: 'Number of worker nodes (0 = master-only, default: 0)',
      default: 0,
    }),
    'disk-size': Flags.integer({
      description:
        'Root disk size in GB. ' +
        'Required for network-storage instance types (Scaleway PRO2, ENT1). ' +
        'Optional for local-SSD types — defaults to the included size of the instance type.',
    }),
    detached: Flags.boolean({
      char: 'd',
      description: 'Detached mode: start cluster creation and exit immediately',
      default: false,
    }),
    wait: Flags.boolean({
      description:
        'Wait for cluster to be ready before returning (polls operation status)',
      default: false,
    }),
    'configure-firewall': Flags.boolean({
      description: 'Automatically configure firewall after cluster creation',
      default: true,
      allowNo: true,
    }),
    'firewall-ip': Flags.string({
      description:
        'Source IP/CIDR for firewall (comma-separated, default: auto-detect)',
    }),
    'non-interactive': Flags.boolean({
      description:
        'Never prompt. Any missing answer becomes an error instead of a question — required when driving the CLI from a script or a managed runner, where a prompt would hang forever holding cloud resources.',
      default: false,
    }),
    'ssh-mode': Flags.string({
      description:
        'How the cluster is reached while it is built. "ca" (default) enrols this machine\'s SSH certificate authority on every node and leaves it there. "ephemeral-key" creates no CA at all and uses a throwaway key that is revoked on the nodes and deleted at the provider before the run ends — the cluster is then unreachable over SSH until its owner runs "flui env adopt". Use it when provisioning on someone else\'s behalf.',
      options: ['ca', 'ephemeral-key'],
      default: 'ca',
    }),
    'auth-mode': Flags.string({
      description: 'Authentication mode (only oidc is supported)',
      default: 'oidc',
    }),
    'acme-staging': Flags.boolean({
      description:
        "Use Let's Encrypt staging endpoint (untrusted cert, no rate limits) — useful while iterating to avoid burning prod quota",
      default: false,
    }),
    latest: Flags.boolean({
      description:
        'Install mobile dev tags instead of the pinned release: bootstrap scripts from `master` and `:latest` Docker images. Default: every component is pinned to the CLI release version.',
      default: false,
    }),
    'no-shared-storage': Flags.boolean({
      description:
        'Disable Flui shared storage (NFS+fscache). Default: shared storage enabled — master gets a Volume hosting the NFS export, workers mount it. Disable to fall back to local-path on each node bundled disk.',
      default: false,
    }),
    'shared-storage-size': Flags.integer({
      description:
        'Size in GB of the master shared storage Volume (only when shared storage is enabled). Default: 20.',
      default: 20,
      min: 10,
    }),
    // BYOS (bring-your-own-server)
    host: Flags.string({
      description:
        'BYOS: install onto an existing Linux host (IP or DNS) over SSH instead of provisioning via a cloud provider. Enables BYOS mode.',
    }),
    port: Flags.integer({
      description: 'BYOS: SSH port of --host (default: 22)',
      default: 22,
    }),
    user: Flags.string({
      description: 'BYOS: SSH user for --host (default: root)',
      default: 'root',
    }),
    'ssh-key': Flags.string({
      description:
        'BYOS: SSH private key for --host. Optional — if omitted, Flui reuses an existing key that already works, otherwise it authorizes one (asking for the host password once) and never stores the password. A passphrase-protected key is supported only when loaded in your ssh-agent (run `ssh-add` first).',
    }),
    'ssh-password': Flags.string({
      description:
        'BYOS: host password, for non-interactive key authorization (e.g. CI). Prefer the FLUI_SSH_PASSWORD env var to keep it out of shell history. Used only in-memory to install the key, then auth switches to the key.',
      env: 'FLUI_SSH_PASSWORD',
    }),
    'master-public-ip': Flags.string({
      description:
        'BYOS: externally reachable IP of --host (defaults to --host); used for endpoints/TLS',
    }),
    'skip-precheck': Flags.boolean({
      description: 'BYOS: skip the host readiness precheck',
      default: false,
    }),
    'best-effort': Flags.boolean({
      description: 'BYOS: continue even if the precheck reports problems',
      default: false,
    }),
    'local-stub': Flags.boolean({
      description:
        'BYOS (dev): stop after bootstrap + CA check; skip observability/kubeconfig/secret patch. Use with BOOTSTRAP_SCRIPTS_URL=file://… for local Podman testing.',
      default: false,
    }),
  };

  /** Providers that already have stored credentials in this profile. */
  private getConfiguredProviders(configStorage: ConfigStorage): string[] {
    return (['hetzner', 'scaleway'] as const).filter((p) =>
      isCompoundProvider(p)
        ? configStorage.hasCredentials(p)
        : configStorage.hasToken(p),
    );
  }

  private resolveKeyPath(flag?: string): string {
    const raw = flag || path.join(os.homedir(), '.ssh', 'id_rsa');
    return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  }

  private async byosPrecheck(
    sshService: CliSshService,
    conn: { host: string; port: number; user: string; keyPath: string },
    bestEffort: boolean,
  ): Promise<void> {
    const probe = await sshService.sshExecWithKey({
      ...conn,
      command:
        '. /etc/os-release 2>/dev/null || true; ' +
        'printf "os=%s\\n" "${PRETTY_NAME:-unknown}"; ' +
        'printf "arch=%s\\n" "$(uname -m)"; ' +
        'printf "memkb=%s\\n" "$(grep MemTotal /proc/meminfo | tr -dc 0-9)"; ' +
        'printf "cpu=%s\\n" "$(nproc)"; ' +
        'printf "k3s=%s\\n" "$(command -v k3s || echo none)"',
    });
    const get = (k: string): string =>
      (new RegExp(`${k}=(.*)`).exec(probe)?.[1] ?? '').trim();
    const memMb = Math.floor(
      (Number.parseInt(get('memkb') || '0', 10) || 0) / 1024,
    );
    const arch = get('arch');
    const k3s = get('k3s');
    console.log(
      chalk.dim(
        `   Host: ${get('os')} · ${arch} · ${memMb}MB RAM · ${get('cpu')} vCPU`,
      ),
    );

    const problems: string[] = [];
    if (!/x86_64|aarch64|arm64/.test(arch))
      problems.push(`unsupported architecture: ${arch}`);
    if (memMb > 0 && memMb < 1800)
      problems.push(`low memory: ${memMb}MB (recommend ≥2GB)`);
    if (k3s !== 'none') problems.push(`k3s already installed at ${k3s}`);

    if (problems.length > 0) {
      const bullets = problems.map((p) => `   • ${p}`).join('\n');
      console.log(chalk.yellow(`\n⚠ Precheck warnings:\n${bullets}\n`));
      if (!bestEffort) {
        this.error(
          'Precheck failed. Re-run with --best-effort to proceed anyway, or --skip-precheck to skip it.',
          { exit: 1 },
        );
      }
    }
  }

  private async runByos(flags: Record<string, any>): Promise<void> {
    const host = flags.host as string;
    const port = (flags.port as number) ?? 22;
    const user = (flags.user as string) ?? 'root';
    const explicitKeyPath = flags['ssh-key']
      ? this.resolveKeyPath(flags['ssh-key'])
      : undefined;
    const masterPublicIp = (flags['master-public-ip'] as string) || host;
    const localStub = !!flags['local-stub'];

    if (explicitKeyPath && !fs.existsSync(explicitKeyPath)) {
      this.error(
        `SSH key not found: ${explicitKeyPath}. Pass a valid --ssh-key <path>, or omit it to auto-resolve/generate one.`,
        { exit: 1 },
      );
    }

    printContextBanner({ cluster: { provider: 'byos', region: host } });

    let spinner = ora('Initializing...').start();
    let app: any;
    try {
      app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const sshService = app.get(CliSshService);
      spinner.succeed('Initialized');

      const existing = await controlService.getControlCluster();
      if (existing && existing.status !== ClusterStatus.DELETED) {
        console.log(
          chalk.yellow(
            '\n⚠️  A control cluster already exists. Destroy it first with `flui env destroy`.\n',
          ),
        );
        return;
      }

      let keyPath = '';
      try {
        const access = await sshService.ensureKeyAccess({
          host,
          port,
          user,
          explicitKeyPath,
          password: flags['ssh-password'],
          log: (m) => console.log(chalk.dim(`   ${m}`)),
        });
        keyPath = access.keyPath;
      } catch (e: any) {
        console.log(chalk.red(`\n❌ SSH access setup failed: ${e.message}\n`));
        console.log(
          chalk.dim(
            `   Verify you can reach the host: ssh -p ${port} ${user}@${host}\n`,
          ),
        );
        this.exit(1);
      }

      if (!flags['skip-precheck']) {
        spinner = ora(`Prechecking ${user}@${host}:${port}...`).start();
        try {
          spinner.stop();
          await this.byosPrecheck(
            sshService,
            { host, port, user, keyPath },
            !!flags['best-effort'],
          );
        } catch (e: any) {
          console.log(chalk.red(`\n❌ Precheck failed: ${e.message}\n`));
          console.log(
            chalk.dim(
              `   Verify access: ssh -p ${port} -i ${keyPath} ${user}@${host}\n`,
            ),
          );
          this.exit(1);
        }
      }

      let adminEmail: string | undefined;
      if (!localStub) {
        const configStorage = new ConfigStorage();
        const resolver = new PreferencesResolver(configStorage);
        const r = resolver.resolve('email');
        if (r.value) {
          adminEmail = r.value;
        } else {
          refuseToAsk(
            'the admin email',
            'Set it first with "flui config set-preference email <address>".',
          );
          adminEmail = await promptInput({
            message: "Admin email (used for Let's Encrypt and notifications)",
            validate: PREFERENCES.email.validate,
          });
          configStorage.setPreference('email', adminEmail);
        }
      }

      console.log(chalk.cyan('\n🚀 Installing Flui on your server (BYOS)\n'));
      console.log(chalk.dim(`   Host:      ${user}@${host}:${port}`));
      console.log(chalk.dim(`   Public IP: ${masterPublicIp}`));
      if (localStub) {
        console.log(
          chalk.yellow('   Mode:      LOCAL STUB (orchestration only)\n'),
        );
      }

      spinner = ora('Starting installation...').start();
      const clusterId = await controlService.createControlClusterByos({
        host,
        port,
        user,
        keyPath,
        masterPublicIp,
        localStub,
        authMode: flags['auth-mode'],
        adminEmail,
        acmeStaging: !!flags['acme-staging'],
        useLatest: !!flags.latest,
      });
      spinner.succeed('Installation started');

      await this.followByosOperation(controlService, clusterId);
    } finally {
      await closeNestApp();
    }
  }

  private async followByosOperation(
    controlService: CliControlClusterService,
    clusterId: string,
  ): Promise<void> {
    const logPath = (opId: string): string =>
      path.join(os.homedir(), '.flui', 'logs', `${opId}.log`);
    let printed = 0;
    const deadline = Date.now() + 30 * 60_000;

    console.log(chalk.dim('\n' + '─'.repeat(80)));
    while (Date.now() < deadline) {
      const op = await controlService.getClusterOperation(clusterId);
      if (op) {
        printed = this.printNewLog(logPath(op.id), printed);
        if (this.handleByosTerminalStatus(op, logPath(op.id))) return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log(
      chalk.yellow(
        '\n⚠ Timed out waiting for installation. Check `flui env status`.\n',
      ),
    );
  }

  private printNewLog(p: string, printed: number): number {
    try {
      const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
      if (content.length > printed) {
        process.stdout.write(content.slice(printed));
        return content.length;
      }
    } catch {
      /* log not ready yet */
    }
    return printed;
  }

  private handleByosTerminalStatus(
    op: { status: OperationStatus; metadata?: Record<string, unknown> | null },
    logPathStr: string,
  ): boolean {
    if (op.status === OperationStatus.COMPLETED) {
      console.log(chalk.dim('─'.repeat(80)));
      console.log(chalk.green('\n✅ Flui installed on your server!\n'));
      console.log(
        chalk.bold('   Retrieve credentials: ') +
          chalk.cyan('flui env credentials\n'),
      );
      return true;
    }
    if (op.status === OperationStatus.FAILED) {
      const err = (op.metadata?.error as string) || 'unknown error';
      console.log(chalk.dim('─'.repeat(80)));
      console.log(chalk.red(`\n❌ Installation failed: ${err}\n`));
      console.log(chalk.dim(`   Full log: ${logPathStr}\n`));
      // closeNestApp() runs in a finally and exits the process itself, before
      // oclif ever sees the ExitError — so the code has to be set here or a
      // failed install reports success to whatever called it.
      process.exitCode = 1;
      this.exit(1);
    }
    return false;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvCreate);

    // Checked before credentials and before any provider call: the default mode
    // follows the bootstrap log over SSH, and that gate waits for a certificate
    // this mode never issues. Left alone it does not fail — it hangs for ten
    // minutes holding paid servers, then gives up.
    if (
      flags['ssh-mode'] === 'ephemeral-key' &&
      !flags.wait &&
      !flags.detached
    ) {
      this.error(
        '--ssh-mode=ephemeral-key needs --wait or --detached: the default mode follows the bootstrap log over SSH, and this mode enrols no certificate authority to authenticate with.',
        { exit: 1 },
      );
    }

    if (flags['non-interactive']) {
      setNonInteractive(true);
      // Auto-detection resolves the *caller's* address. That is right on a
      // laptop and wrong everywhere else: a managed runner or a CI job would
      // open the cluster to itself and lock the operator out of their own
      // machine. Headless callers must say who they are.
      if (flags['configure-firewall'] && !flags['firewall-ip']) {
        this.error(
          'Running non-interactively requires --firewall-ip: auto-detection would open the firewall to whichever machine runs this command, not to you. Pass --no-configure-firewall to skip firewall setup entirely.',
          { exit: 1 },
        );
      }
    }

    if (flags['auth-mode'] !== 'oidc') {
      this.error(
        `Authentication mode '${flags['auth-mode']}' is not supported. Only 'oidc' is available.`,
        { exit: 1 },
      );
    }

    if (flags.host) {
      return this.runByos(flags);
    }

    const configStorage = new ConfigStorage();
    const hasCreds = (p: string): boolean =>
      isCompoundProvider(p)
        ? configStorage.hasCredentials(p)
        : configStorage.hasToken(p);

    // Precedence: explicit --provider > already-configured provider(s) > setup wizard.
    // One configured provider is auto-selected, several are offered as a pick list.
    let providerKey = flags.provider;
    if (!providerKey) {
      const configured = this.getConfiguredProviders(configStorage);
      if (configured.length === 1) {
        providerKey = configured[0];
      } else if (configured.length > 1) {
        refuseToAsk(
          'which of the configured providers to use',
          'Pass --provider <hetzner|scaleway>.',
        );
        const picked = await selectConfiguredProvider(configured);
        if (!picked) this.exit(1);
        providerKey = picked;
      }
    }
    if (!providerKey || !hasCreds(providerKey)) {
      refuseToAsk(
        `credentials for ${providerKey ?? 'a provider'}`,
        `Configure them first with "flui config set ${providerKey ?? '<provider>'}".`,
      );
      const configured = await runProviderSetupWizard(providerKey);
      if (!configured) {
        console.log(
          chalk.dim(
            `   To configure manually: flui config set ${providerKey ?? '<provider>'}\n`,
          ),
        );
        this.exit(1);
      }
      providerKey = configured;
    }

    const cloudProvider =
      providerKey === 'scaleway'
        ? CloudProvider.SCALEWAY
        : CloudProvider.HETZNER;
    const nodeSize =
      flags['node-size'] || getRecommendedServerType(providerKey);
    const region = flags.region || getDefaultRegion(providerKey);
    const allowedRegions = getEuRegions(providerKey);

    if (!allowedRegions.includes(region)) {
      this.error(
        `Region '${region}' is not supported for provider '${providerKey}'. Allowed: ${allowedRegions.join(', ')}`,
        { exit: 1 },
      );
    }

    printContextBanner({
      cluster: { provider: providerKey, region },
    });

    let spinner = ora('Initializing...').start();
    let app: any;
    let firewallId: string | undefined;
    let sourceCidrs: string[] | undefined;

    try {
      // 1. Bootstrap NestJS and get services
      app = await getNestApp();
      spinner.succeed('Initialized');

      spinner = ora('Loading services...').start();
      const apiUrl = configStorage.getApiUrl();
      const controlService = app.get(CliControlClusterService);
      const apiClient = new ApiClient({
        baseUrl: apiUrl,
        apiKey: configStorage.getApiKey(),
      });
      const cacheService = new ServerTypeCacheService();
      const validatorService = new ServerTypeValidatorService();
      spinner.succeed('Services loaded');
      emitEvent({
        type: 'phase',
        phase: 'init',
        state: 'completed',
        percent: 5,
      });

      // 3. Resolve admin email (prompt if not set, then persist)
      const emailResolver = new PreferencesResolver(configStorage);
      const emailResult = emailResolver.resolve('email');
      let adminEmail: string;
      if (emailResult.value) {
        adminEmail = emailResult.value;
      } else {
        spinner.stop();
        refuseToAsk(
          'the admin email',
          'Set it first with "flui config set-preference email <address>".',
        );
        adminEmail = await promptInput({
          message: "Admin email (used for Let's Encrypt and notifications)",
          validate: PREFERENCES.email.validate,
        });
        configStorage.setPreference('email', adminEmail);
        spinner = ora('Resuming...').start();
        spinner.succeed('Email saved');
      }

      // ACME server choice: production by default. Staging only via explicit
      // --acme-staging flag (untrusted certs break SSO discovery, so we never
      // auto-fall-back). Each cluster gets a unique nip.io hostname token
      // server-side, so the LE 5-certs-per-7-days rate limit never trips on
      // repeated test creations.
      const acmeStaging = flags['acme-staging'];
      const useLatest = flags.latest;
      spinner.stop();
      const overrideBanner = formatReleaseOverrideBanner(
        getEffectiveRelease(useLatest),
      );
      if (overrideBanner) {
        console.log(overrideBanner);
      }
      if (acmeStaging) {
        console.log(
          chalk.yellow(
            `\n⚠ ACME endpoint: Let's Encrypt STAGING — cert will not be browser-trusted (warning expected).\n`,
          ),
        );
      } else {
        const recent = configStorage
          .getAcmeIssuances()
          .filter((i) => i.server === 'production');
        const byDomain = recent.reduce<Record<string, number>>((acc, i) => {
          acc[i.domains] = (acc[i.domains] ?? 0) + 1;
          return acc;
        }, {});
        if (recent.length > 0) {
          const lines = Object.entries(byDomain)
            .map(([d, n]) => `   • ${d} (${n})`)
            .join('\n');
          console.log(
            chalk.dim(
              `\nℹ ACME endpoint: Let's Encrypt PRODUCTION (browser-trusted cert).\n` +
                `   Issuances seen in the last 7 days (per domain set):\n${lines}\n`,
            ),
          );
        } else {
          console.log(
            chalk.dim(
              `\nℹ ACME endpoint: Let's Encrypt PRODUCTION (browser-trusted cert).\n`,
            ),
          );
        }
      }
      spinner = ora('Resuming...').start();

      // 3. Validate server type with multi-region fallback
      spinner = ora(
        'Validating server type and region availability...',
      ).start();
      let validatedNodeSize = nodeSize;
      let validatedRegion = region;
      let serverTypes = await cacheService.get(providerKey);

      if (!serverTypes) {
        spinner.text = 'Fetching available server types...';
        try {
          serverTypes = await apiClient.getNodeSizes(providerKey);
          await cacheService.set(providerKey, serverTypes);
        } catch (error) {
          spinner.warn(
            `Could not fetch server types: ${error.message}. Proceeding with requested type.`,
          );
          serverTypes = [];
        }
      }

      if (serverTypes.length > 0) {
        const euRegions = allowedRegions;
        const fallbackRegions = euRegions.filter((r) => r !== region);
        const fallbackTypes = getFallbackServerTypes(providerKey);

        const validation =
          validatorService.validateServerTypeWithRegionFallback(
            nodeSize,
            serverTypes,
            region,
            fallbackRegions,
            fallbackTypes,
          );

        if (!validation.isValid) {
          spinner.fail(validation.reason);

          if (validation.suggestedAlternative) {
            const regionInfo =
              validation.suggestedRegion &&
              validation.suggestedRegion !== region
                ? ` in region ${validation.suggestedRegion}`
                : '';

            console.log(
              chalk.yellow(
                `\n💡 Suggested alternative: ${validation.suggestedAlternative.name}${regionInfo}\n`,
              ),
            );

            const oldPrice = nodeSize === 'cx22' ? '7.50' : undefined;
            refuseToAsk(
              `whether to accept ${validation.suggestedAlternative.name} instead of ${nodeSize}`,
              'Pass an available --node-size, or run "flui server-types list" to pick one.',
            );
            const confirmed = await confirmAlternativeServerType(
              nodeSize,
              validation.suggestedAlternative,
              oldPrice,
            );

            if (confirmed) {
              validatedNodeSize = validation.suggestedAlternative.id;
              if (
                validation.suggestedRegion &&
                validation.suggestedRegion !== region
              ) {
                validatedRegion = validation.suggestedRegion;
                console.log(
                  chalk.green(
                    `✓ Using ${validation.suggestedAlternative.name} in region ${validatedRegion}\n`,
                  ),
                );
              } else {
                console.log(
                  chalk.green(
                    `✓ Using ${validation.suggestedAlternative.name}\n`,
                  ),
                );
              }
            } else {
              // Let user select manually from available types in any EU region
              const availableTypes = serverTypes.filter((t) => {
                if (t.deprecated) return false;

                // Use real-time availability if present
                if (t.availability && t.availability.length > 0) {
                  return t.availability.some(
                    (av) =>
                      euRegions.includes(av.location) &&
                      av.available &&
                      !av.deprecated,
                  );
                }

                // Fallback to locations
                return t.locations.some(
                  (loc) => euRegions.includes(loc.name) && !loc.deprecation,
                );
              });

              const selected = await selectServerTypePrompt(
                availableTypes,
                'Please select a server type:',
              );

              if (selected) {
                validatedNodeSize = selected.id;

                // Find best region for selected type
                let selectedRegions: string[];
                if (selected.availability && selected.availability.length > 0) {
                  selectedRegions = selected.availability
                    .filter(
                      (av) =>
                        euRegions.includes(av.location) &&
                        av.available &&
                        !av.deprecated,
                    )
                    .map((av) => av.location);
                } else {
                  selectedRegions = selected.locations
                    .filter(
                      (loc) => euRegions.includes(loc.name) && !loc.deprecation,
                    )
                    .map((loc) => loc.name);
                }

                if (
                  !selectedRegions.includes(region) &&
                  selectedRegions.length > 0
                ) {
                  validatedRegion = selectedRegions[0];
                  console.log(
                    chalk.yellow(
                      `Note: ${selected.name} is not available in ${region}, using ${validatedRegion} instead`,
                    ),
                  );
                }

                console.log(chalk.green(`✓ Using ${selected.name}\n`));
              } else {
                console.log(chalk.red('Operation cancelled by user\n'));
                this.exit(0);
              }
            }
          } else {
            displayServerTypeNotFoundError(nodeSize, providerKey);
            console.log(
              chalk.yellow(
                `Run: flui server-types list --provider ${providerKey}\n`,
              ),
            );
            this.exit(1);
          }
        } else if (
          validation.suggestedRegion &&
          validation.suggestedRegion !== region
        ) {
          validatedRegion = validation.suggestedRegion;
          spinner.succeed(
            `Server type validated (available in ${validatedRegion} instead of ${region})`,
          );
        } else {
          spinner.succeed('Server type and region validated');
          emitEvent({
            type: 'phase',
            phase: 'validate',
            state: 'completed',
            percent: 10,
          });
        }
      } else {
        spinner.succeed('Server type validation skipped (no data available)');
      }

      // Display cluster configuration
      console.log(chalk.cyan('\n🚀 Creating Flui Control Cluster (K3s)\n'));
      console.log(chalk.dim(`   Provider: ${providerKey}`));
      console.log(chalk.dim(`   Node Size: ${validatedNodeSize}`));
      console.log(chalk.dim(`   Region: ${validatedRegion}`));
      console.log(chalk.dim(`   Worker Nodes: ${flags['node-count']}\n`));

      // 3. Check if control cluster already exists
      spinner = ora('Checking for existing cluster...').start();
      const existingCluster = await controlService.getControlCluster();

      if (existingCluster && existingCluster.status !== ClusterStatus.DELETED) {
        spinner.fail('Control cluster already exists!');
        console.log(
          chalk.yellow('\n⚠️  An control cluster is already running:\n'),
        );
        console.log(`   ${chalk.bold('Name:')}     ${existingCluster.name}`);
        console.log(`   ${chalk.bold('ID:')}       ${existingCluster.id}`);
        console.log(`   ${chalk.bold('Status:')}   ${existingCluster.status}`);
        console.log(
          `   ${chalk.bold('Nodes:')}    ${existingCluster.nodeCount}`,
        );
        console.log(`   ${chalk.bold('Region:')}   ${existingCluster.region}`);
        console.log(chalk.yellow('\nUse the following commands to manage it:'));
        console.log(`   ${chalk.cyan('flui env status')}   - Check status`);
        console.log(
          `   ${chalk.cyan('flui env destroy')}  - Delete permanently\n`,
        );
        return;
      }
      spinner.succeed('No existing cluster found');

      // 3.5. Provision environment VNet+Subnet BEFORE the cluster.
      //      Every server (master + workers) and every future workload cluster
      //      joins this private network so intra/inter-cluster traffic stays
      //      off the public interface.
      let envVnetInfo:
        | Awaited<ReturnType<VnetProvisioningService['ensureEnvVnet']>>
        | undefined;
      try {
        spinner = ora('Provisioning environment VNet/Subnet...').start();
        const vnetService = app.get(VnetProvisioningService);
        // Announced before the call and retracted after if an existing VNet
        // was reused. The reverse — announcing only what came back — would
        // leave a network unaccounted for whenever the process dies mid-create,
        // and claiming one we merely joined would point a cleanup tool at
        // somebody else's private network.
        const envVnetName = `flui-env-${contextTag()}-${randomBytes(3).toString('hex')}`;
        emitEvent({
          type: 'resource',
          kind: 'network',
          id: null,
          name: envVnetName,
        });
        envVnetInfo = await vnetService.ensureEnvVnet({
          provider: cloudProvider,
          name: envVnetName,
          ipRange: '10.10.0.0/16',
          subnetIpRange: '10.10.1.0/24',
          networkZone:
            cloudProvider === CloudProvider.HETZNER
              ? vnetService.hetznerNetworkZoneFor(validatedRegion)
              : undefined,
          region:
            cloudProvider === CloudProvider.SCALEWAY
              ? validatedRegion
              : undefined,
        });
        emitEvent(
          envVnetInfo.created
            ? {
                type: 'resource',
                kind: 'network',
                id: envVnetInfo.vnetProviderResourceId,
                name: envVnetInfo.vnetName,
              }
            : { type: 'released', name: envVnetName },
        );
        spinner.succeed(
          `VNet ready: ${envVnetInfo.vnetProviderResourceId} (subnet ${envVnetInfo.subnetIpRange})`,
        );
      } catch (error) {
        spinner.fail(`VNet provisioning failed: ${(error as Error).message}`);
        console.log(
          chalk.red(
            '\n   Cannot proceed without an environment VNet. The control cluster and all workload clusters must share a private network.',
          ),
        );
        this.exit(1);
      }

      // 4. Create firewall BEFORE cluster (if enabled)
      if (flags['configure-firewall']) {
        spinner = ora('Creating firewall...').start();

        try {
          const ipService = app.get(IpDetectionService);
          const firewallFactory = app.get(FirewallProviderFactory);
          const firewallService =
            firewallFactory.getFirewallProviderOrFail(cloudProvider);
          const firewallRepo = app.get(CliFirewallRepository);

          // Detect or parse source IP/CIDR
          if (flags['firewall-ip']) {
            sourceCidrs = ipService.parseCidrList(flags['firewall-ip']);
          } else {
            const publicIp = await ipService.getPublicIp();
            sourceCidrs = [ipService.toCidr(publicIp)];
          }

          const rules = CONTROL_FIREWALL_RULES(sourceCidrs);
          // Unique temporary name to avoid colliding with orphaned firewalls
          // from previous runs; renamed to flui-control-firewall-<clusterId>
          // (by firewallId) once the cluster is ready.
          const temporaryFirewallName = `flui-control-firewall-${contextTag()}-${randomBytes(4).toString('hex')}`;

          // Create firewall with temporary name (will be renamed when cluster is ready)
          emitEvent({
            type: 'resource',
            kind: 'firewall',
            id: null,
            name: temporaryFirewallName,
          });
          const result = await firewallService.createFirewall({
            name: temporaryFirewallName,
            labels: [
              { key: 'managed-by', value: 'flui-cloud' },
              { key: 'flui-resource-type', value: 'firewall' },
              { key: 'flui-cluster-type', value: 'control' },
              contextLabelPair(),
            ],
            rules,
            // Label selector will be applied later when cluster servers exist
          });

          firewallId = result.firewallId;
          emitEvent({
            type: 'resource',
            kind: 'firewall',
            id: firewallId,
            name: temporaryFirewallName,
          });

          await firewallRepo.save({
            id: firewallId,
            name: temporaryFirewallName,
            provider: cloudProvider.toUpperCase(),
            clusterId: '',
            rules,
            sourceCidrs,
            appliedToServerIds: [],
            labels: [
              { key: 'managed-by', value: 'flui-cloud' },
              { key: 'flui-resource-type', value: 'firewall' },
            ],
          });

          spinner.succeed(
            `Firewall created (Source: ${sourceCidrs.join(', ')})`,
          );
        } catch (error) {
          spinner.fail(`Firewall creation failed: ${error.message}`);
          console.log(
            chalk.red(
              '\n   Aborting: the control cluster must not be provisioned without a firewall.',
            ),
          );
          console.log(
            chalk.dim(
              '   Resolve the cause (e.g. remove a leftover/orphaned firewall on the provider) and retry,\n   or pass --no-configure-firewall to explicitly opt out of firewall protection.',
            ),
          );
          this.exit(1);
        }
      }

      // 5. Create K3s cluster
      spinner = ora('Creating K3s cluster...').start();
      console.log(
        chalk.dim(
          flags['node-count'] > 0
            ? '   This will create master node + worker nodes'
            : '   This will create master node only',
        ),
      );

      const clusterId = await controlService.createControlCluster(
        cloudProvider,
        validatedRegion,
        validatedNodeSize,
        flags['node-count'],
        firewallId,
        sourceCidrs,
        flags['auth-mode'],
        envVnetInfo
          ? {
              vnetProviderResourceId: envVnetInfo.vnetProviderResourceId,
              vnetIpRange: envVnetInfo.vnetIpRange,
              subnetProviderResourceId: envVnetInfo.subnetProviderResourceId,
              subnetIpRange: envVnetInfo.subnetIpRange,
              subnetType: envVnetInfo.subnetType,
              networkZone: envVnetInfo.networkZone,
            }
          : undefined,
        adminEmail,
        acmeStaging,
        flags['disk-size'],
        {
          sharedStorageEnabled: !flags['no-shared-storage'],
          sharedStorageVolumeSizeGb: flags['shared-storage-size'],
          useLatest,
          sshMode: flags['ssh-mode'] as SshMode,
        },
      );

      spinner.succeed('Cluster creation started!');
      emitEvent({
        type: 'phase',
        phase: 'server-create',
        state: 'started',
        percent: 12,
      });

      if (firewallId && clusterId) {
        try {
          const fwRepo = app.get(CliFirewallRepository);
          const existing = await fwRepo.findById(firewallId);
          if (existing && !existing.clusterId) {
            await fwRepo.save({ ...existing, clusterId });
          }
        } catch (e) {
          console.log(
            chalk.yellow(
              `   ⚠️  Could not link firewall ${firewallId} to cluster ${clusterId}: ${(e as Error).message}`,
            ),
          );
        }
      }

      // Validate mutual exclusivity
      if (flags.wait && flags.detached) {
        this.error('Cannot use --wait and --detached together');
      }

      if (flags.detached) {
        // DETACHED MODE: Exit immediately with monitoring instructions
        console.log(chalk.green('\n✅ Control Cluster Creation Started!\n'));
        console.log(chalk.cyan('📋 Cluster Details:\n'));
        console.log(`   ${chalk.bold('Cluster ID:')}  ${clusterId}`);
        console.log(`   ${chalk.bold('Provider:')}    ${cloudProvider}`);
        console.log(`   ${chalk.bold('Region:')}      ${validatedRegion}`);
        console.log(`   ${chalk.bold('Node Size:')}   ${validatedNodeSize}`);
        console.log(`   ${chalk.bold('Worker Nodes:')} ${flags['node-count']}`);
        console.log(
          `   ${chalk.bold('Status:')}      ${chalk.yellow('Creating in background')}`,
        );

        console.log(chalk.cyan('\n📊 Monitor Progress:\n'));
        console.log(
          `   ${chalk.cyan('flui env status')}   - Check cluster creation progress`,
        );

        if (firewallId && sourceCidrs) {
          console.log(chalk.cyan('\n🔥 Firewall:\n'));
          console.log(
            chalk.green(
              `   ✅ Firewall created (Source: ${sourceCidrs.join(', ')})`,
            ),
          );
          console.log(
            chalk.dim(
              '   Will be applied automatically when cluster is ready.',
            ),
          );
        }

        console.log(
          chalk.cyan(
            '\n💡 Tip: Run without -d to follow provisioning logs in real-time\n',
          ),
        );
        console.log('');
      } else if (flags.wait) {
        // WAIT MODE: Wait for cluster to be ready
        spinner = ora('Waiting for cluster to be ready...').start();

        try {
          await controlService.waitForClusterReady(clusterId, 600000);
          spinner.succeed('Cluster is ready!');
          emitEvent({
            type: 'phase',
            phase: 'k3s-install',
            state: 'completed',
            percent: 55,
          });
        } catch (error) {
          spinner.fail('Failed to wait for cluster');
          console.log(chalk.red(`\n❌ Error: ${error.message}\n`));
          this.exit(1);
        }

        console.log(
          chalk.green('\n✅ Control Cluster Created Successfully!\n'),
        );
        console.log(chalk.cyan('📋 Cluster Details:\n'));
        console.log(`   ${chalk.bold('Cluster ID:')}  ${clusterId}`);
        console.log(`   ${chalk.bold('Provider:')}    ${cloudProvider}`);
        console.log(`   ${chalk.bold('Region:')}      ${validatedRegion}`);
        console.log(`   ${chalk.bold('Node Size:')}   ${validatedNodeSize}`);
        console.log(`   ${chalk.bold('Worker Nodes:')} ${flags['node-count']}`);

        if (firewallId && sourceCidrs) {
          console.log(chalk.cyan('\n🔥 Firewall:\n'));
          console.log(
            chalk.green(
              `   ✅ Firewall configured and applied (Source: ${sourceCidrs.join(', ')})`,
            ),
          );
        }

        console.log(chalk.cyan('\n📊 Manage Cluster:\n'));
        console.log(
          `   ${chalk.cyan('flui env status')}   - Check cluster status`,
        );
        console.log(`   ${chalk.cyan('flui env destroy')}  - Delete cluster`);

        if (flags['ssh-mode'] === 'ephemeral-key') {
          console.log(chalk.cyan('\n🔑 SSH Access:\n'));
          console.log(
            chalk.dim(
              '   None. No certificate authority was enrolled and the bootstrap key\n' +
                '   has been revoked, so nothing can open a shell on these nodes.\n' +
                '   The owner opens that door with: flui env adopt <token>',
            ),
          );
        } else {
          console.log(chalk.cyan('\n🔑 SSH Access:\n'));
          console.log(
            `   ${chalk.cyan('flui ssh master')}   - SSH to master node`,
          );
          if (flags['node-count'] > 0) {
            console.log(
              `   ${chalk.cyan('flui ssh worker-1')} - SSH to worker node`,
            );
          }
        }

        const readyCluster = await controlService.getControlCluster();
        if (readyCluster?.masterIpAddress) {
          emitEvent({
            type: 'ready',
            endpoint: buildNipBaseDomain(
              readyCluster.masterIpAddress,
              readyCluster.nipHostnameToken,
            ),
          });
        }

        console.log('');
      } else {
        // DEFAULT MODE: Follow logs + auto-reconcile on READY
        const sshService = app.get(CliSshService);
        let pollerHandle: { stop: () => void; done: Promise<void> } | null =
          null;

        // Start background poller immediately (independent of SSH)
        // This ensures reconciliation runs even if SSH setup fails
        let shouldExit = false;

        const onReconcile = async (): Promise<void> => {
          const cluster = await controlService.getControlCluster();
          const masterIp = cluster?.masterIpAddress;
          const nipToken = cluster?.nipHostnameToken;
          const baseDomain = buildNipBaseDomain(masterIp ?? '', nipToken);

          if (masterIp) {
            const certUrl = `https://auth.${baseDomain}`;
            console.log(
              chalk.dim(
                `\n→ Waiting for website certificate (Let's Encrypt)...`,
              ),
            );

            let elapsed = 0;
            const maxWait = 300_000;
            const interval = 15_000;
            const deadline = Date.now() + maxWait;

            while (Date.now() < deadline) {
              const valid = await controlService.waitForValidTls(
                certUrl,
                interval,
                interval,
                acmeStaging,
              );
              if (valid) break;
              elapsed += interval;
              console.log(
                chalk.dim(
                  `  Certificate pending... (${Math.round(elapsed / 1000)}s / ${maxWait / 1000}s)`,
                ),
              );
            }

            const tlsReady = await controlService.waitForValidTls(
              certUrl,
              5_000,
              5_000,
              acmeStaging,
            );
            if (tlsReady) {
              console.log(
                chalk.green(
                  acmeStaging
                    ? "✅ TLS certificate valid (Let's Encrypt STAGING — not browser-trusted)"
                    : '✅ TLS certificate valid',
                ),
              );
              configStorage.recordAcmeIssuance({
                domains: `auth/api/app.${baseDomain}`,
                server: acmeStaging ? 'staging' : 'production',
              });
            } else {
              console.log(
                chalk.yellow(
                  '⚠ Certificate not ready — cluster usable but browser may show SSL warning',
                ),
              );
            }

            const apiBaseUrl = `https://api.${baseDomain}`;

            if (flags['auth-mode'] === 'oidc') {
              const fluiApiKey = cluster?.metadata?.fluiApiKey as
                | string
                | undefined;
              if (fluiApiKey) {
                console.log(
                  chalk.dim(
                    `\n→ Triggering OIDC bootstrap (Zitadel project, apps, admin)...`,
                  ),
                );
                try {
                  const apiClient = new ApiClient({
                    baseUrl: `${apiBaseUrl}/api/v1`,
                    apiKey: fluiApiKey,
                  });
                  await apiClient.post('/auth/bootstrap');
                  console.log(chalk.green('✅ OIDC bootstrap triggered'));
                } catch (err: any) {
                  console.log(
                    chalk.yellow(
                      `⚠ OIDC bootstrap call failed (${err.message}) — will retry via polling`,
                    ),
                  );
                }
              }

              console.log(
                chalk.dim(`\n→ Waiting for OIDC client provisioning...`),
              );
              const oidcReady = await controlService.waitForOidcReady(
                apiBaseUrl,
                300_000,
                10_000,
                acmeStaging,
              );
              if (oidcReady) {
                console.log(chalk.green('✅ OIDC login ready'));
              } else {
                console.log(
                  chalk.yellow(
                    '⚠ OIDC login not ready — the dashboard sign-in will fail until this is resolved.',
                  ),
                );
                console.log(
                  chalk.dim(
                    '   Diagnose with `flui env status`, or `flui ssh master` + kubectl (check the zitadel and flui-web pods).\n' +
                      '   `flui env force-ready` does NOT retry bootstrap — it only overrides the local status, so use it only after the cause is fixed.',
                  ),
                );
              }
            }
          }

          console.log(
            chalk.green(
              '\n' +
                '─'.repeat(80) +
                '\n✅ Cluster is READY!\n' +
                '─'.repeat(80) +
                '\n',
            ),
          );

          if (masterIp) {
            console.log(
              `   ${chalk.bold('Frontend:')} https://app.${baseDomain}`,
            );
          }

          console.log(chalk.bold('\n   To retrieve your credentials, run:'));
          console.log(chalk.cyan('   flui env credentials\n'));

          // Signal auto-exit
          shouldExit = true;
        };

        const onFailed = (errorMsg: string): void => {
          console.log(
            chalk.red(
              '\n\n' +
                '─'.repeat(80) +
                `\n❌ Cluster creation failed: ${errorMsg}\n` +
                '─'.repeat(80) +
                '\n',
            ),
          );
          shouldExit = true;
        };

        pollerHandle = controlService.pollOperationUntilReady(
          clusterId,
          onReconcile,
          onFailed,
        );

        // Phase 1: Wait for server provisioning (master IP)
        spinner = ora('Provisioning server...').start();
        let masterIp: string;
        try {
          masterIp = await controlService.waitForMasterIp(
            clusterId,
            600000,
            5000,
          );
          spinner.succeed(`Server provisioned (${masterIp})`);
        } catch (error) {
          spinner.fail('Server provisioning failed');
          console.log(chalk.red(`\n❌ Error: ${error.message}\n`));
          console.log(chalk.yellow('You can check status manually:'));
          console.log(`   ${chalk.cyan('flui env status')}\n`);
          console.log(
            chalk.dim(
              'Waiting for cluster to finish (reconciliation will run automatically)...\n',
            ),
          );
          await pollerHandle.done;
          await closeNestApp();
          process.exit(0);
        }

        // Phase 2: Wait for server boot (SSH port open)
        spinner = ora('Server booting...').start();
        try {
          await controlService.waitForPortReady(masterIp, 22, 600000, 5000);
          spinner.succeed('Server online');
        } catch (error) {
          spinner.fail('Server did not come online in time');
          console.log(chalk.red(`\n❌ Error: ${error.message}\n`));
          console.log(
            chalk.dim(
              'Waiting for cluster to finish (reconciliation will run automatically)...\n',
            ),
          );
          await pollerHandle.done;
          await closeNestApp();
          process.exit(0);
        }

        // Phase 3: Wait for SSH authentication (CA enrollment via cloud-init)
        spinner = ora('Waiting for SSH access (CA enrollment)...').start();
        try {
          await controlService.waitForSshAuth(
            () => sshService.sshExec(masterIp, 'echo ok'),
            600000,
            10000,
          );
          spinner.succeed('SSH access ready');
          emitEvent({
            type: 'phase',
            phase: 'ssh-ready',
            state: 'completed',
            percent: 65,
          });
        } catch (error) {
          spinner.fail('SSH access did not become ready in time');
          console.log(chalk.red(`\n❌ Error: ${error.message}\n`));
          console.log(
            chalk.yellow('You can inspect logs manually when ready:'),
          );
          console.log(`   ${chalk.cyan('flui env inspect -f')}\n`);
          console.log(
            chalk.dim(
              'Waiting for cluster to finish (reconciliation will run automatically)...\n',
            ),
          );
          await pollerHandle.done;
          await closeNestApp();
          process.exit(0);
        }

        // Phase 4: Stream cloud-init-output logs
        const logPath = '/var/log/cloud-init-output.log';

        console.log(
          chalk.cyan('\n📋 Streaming cloud-init-output from master node\n'),
        );
        console.log(chalk.dim(`   Node: master (${masterIp})`));
        console.log(chalk.dim(`   Log: ${logPath}`));
        console.log(chalk.dim(`   Press Ctrl+C to stop\n`));
        console.log(chalk.dim('─'.repeat(80)));

        let sshCleanup: (() => void) | null = null;

        const exitHandler = (): void => {
          console.log(chalk.dim('\n\n' + '─'.repeat(80)));
          console.log(chalk.yellow('\nStopping log stream...\n'));
          if (pollerHandle) {
            pollerHandle.stop();
          }
          if (sshCleanup) {
            sshCleanup();
          }
          closeNestApp().then(() => process.exit(0));
        };

        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);

        try {
          const stream = await sshService.streamRemoteLog(masterIp, logPath);
          sshCleanup = stream.cleanup;

          // Keep streaming until reconciliation completes or Ctrl+C
          await new Promise<void>((resolve) => {
            const checkExit = setInterval(() => {
              if (shouldExit) {
                clearInterval(checkExit);
                resolve();
              }
            }, 1000);
          });

          // Auto-exit after reconciliation
          if (sshCleanup) {
            sshCleanup();
          }
          await closeNestApp();
          process.exit(0);
        } catch (error) {
          console.log(chalk.red('\n❌ SSH Stream Error:\n'));
          console.log(`   ${error.message}\n`);
          console.log(chalk.yellow('Troubleshooting:'));
          console.log('   - The node may still be booting');
          console.log('   - Check firewall rules allow SSH');
          console.log(chalk.dim('\nTry again with:'));
          console.log(`   ${chalk.cyan('flui env inspect -f')}\n`);
          console.log(
            chalk.dim(
              'Waiting for cluster to finish (reconciliation will run automatically)...\n',
            ),
          );
          await pollerHandle.done;
          await closeNestApp();
          process.exit(0);
        }
      }
    } catch (error) {
      spinner.fail('Failed to create control cluster');
      emitEvent({
        type: 'failed',
        phase: 'create',
        message: error instanceof Error ? error.message : String(error),
      });

      if (firewallId) {
        try {
          spinner = ora('Cleaning up orphaned firewall...').start();
          const firewallFactory = app.get(FirewallProviderFactory);
          const firewallService =
            firewallFactory.getFirewallProviderOrFail(cloudProvider);
          const firewallRepo = app.get(CliFirewallRepository);

          await firewallService.deleteFirewall(firewallId);
          await firewallRepo.delete(firewallId);
          emitEvent({ type: 'released', name: firewallId });

          spinner.succeed('Orphaned firewall cleaned up');
        } catch (cleanupError) {
          spinner.warn(
            `Failed to cleanup firewall ${firewallId}: ${cleanupError.message}`,
          );
          console.log(
            chalk.yellow(
              `   You may need to manually delete firewall ${firewallId}`,
            ),
          );
        }
      }

      console.log(chalk.red('\n❌ Error:\n'));

      if (error instanceof Error) {
        console.log(`   ${error.message}`);

        if (error.message.includes('already exists')) {
          console.log(chalk.yellow('\n💡 Hint:'));
          console.log(`   Delete the existing cluster first:`);
          console.log(`   ${chalk.cyan('flui env destroy')}\n`);
        } else if (
          error.message.includes('token') ||
          error.message.includes('credentials')
        ) {
          console.log(chalk.yellow('\n💡 Hint:'));
          console.log(`   Make sure you've set your ${providerKey} API token:`);
          const setCmd = chalk.cyan(
            `flui config set ${providerKey} YOUR_TOKEN`,
          );
          console.log(`   ${setCmd}\n`);
        }
      } else {
        console.log(`   ${String(error)}`);
      }

      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
