import { randomBytes } from 'node:crypto';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { buildNipBaseDomain } from '../../lib/nip-base-domain.util';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { FirewallProviderFactory } from 'src/modules/providers/core/factories/firewall-provider.factory';
import { IpDetectionService } from '../../lib/utils/ip-detection';
import { CliFirewallRepository } from '../../lib/repositories/cli-firewall.repository';
import { CONTROL_FIREWALL_RULES } from '../../lib/templates/firewall-rules';
import { VnetProvisioningService } from '../../lib/services/vnet-provisioning.service';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { isCompoundProvider } from '../../lib/provider-credential-schemas';
import { printContextBanner } from '../../lib/context-banner';
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
  promptInput,
} from '../../lib/prompts';
import { PreferencesResolver } from '../../config/preferences-resolver';
import { PREFERENCES } from '../../config/preferences-schema';

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
    'auth-mode': Flags.string({
      description: 'Authentication mode (only oidc is supported)',
      default: 'oidc',
    }),
    'acme-staging': Flags.boolean({
      description:
        "Use Let's Encrypt staging endpoint (untrusted cert, no rate limits) — useful while iterating to avoid burning prod quota",
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
  };

  /** The sole provider with configured credentials, or undefined if none/both. */
  private detectConfiguredProvider(
    configStorage: ConfigStorage,
  ): string | undefined {
    const configured = (['hetzner', 'scaleway'] as const).filter((p) =>
      isCompoundProvider(p)
        ? configStorage.hasCredentials(p)
        : configStorage.hasToken(p),
    );
    return configured.length === 1 ? configured[0] : undefined;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvCreate);

    if (flags['auth-mode'] !== 'oidc') {
      this.error(
        `Authentication mode '${flags['auth-mode']}' is not supported. Only 'oidc' is available.`,
        { exit: 1 },
      );
    }

    const configStorage = new ConfigStorage();
    const hasCreds = (p: string): boolean =>
      isCompoundProvider(p)
        ? configStorage.hasCredentials(p)
        : configStorage.hasToken(p);

    // Resolve the target provider BEFORE deriving provider-specific defaults.
    // Precedence: explicit --provider > the profile's single configured
    // provider > the setup wizard's choice. (Previously hard-defaulted to
    // hetzner, so a Scaleway-only profile still tried — and failed — to build
    // on Hetzner.)
    let providerKey =
      flags.provider ?? this.detectConfiguredProvider(configStorage);
    if (!providerKey || !hasCreds(providerKey)) {
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

      // 3. Resolve admin email (prompt if not set, then persist)
      const emailResolver = new PreferencesResolver(configStorage);
      const emailResult = emailResolver.resolve('email');
      let adminEmail: string;
      if (emailResult.value) {
        adminEmail = emailResult.value;
      } else {
        spinner.stop();
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
      spinner.stop();
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
        envVnetInfo = await vnetService.ensureEnvVnet({
          provider: cloudProvider,
          name: `flui-env-${randomBytes(3).toString('hex')}`,
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
          const temporaryFirewallName = `flui-control-firewall-${randomBytes(4).toString('hex')}`;

          // Create firewall with temporary name (will be renamed when cluster is ready)
          const result = await firewallService.createFirewall({
            name: temporaryFirewallName,
            labels: [
              { key: 'managed-by', value: 'flui-cloud' },
              { key: 'flui-resource-type', value: 'firewall' },
              { key: 'flui-cluster-type', value: 'control' },
            ],
            rules,
            // Label selector will be applied later when cluster servers exist
          });

          firewallId = result.firewallId;

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
        },
      );

      spinner.succeed('Cluster creation started!');

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

        console.log(chalk.cyan('\n🔑 SSH Access:\n'));
        console.log(
          `   ${chalk.cyan('flui ssh master')}   - SSH to master node`,
        );
        if (flags['node-count'] > 0) {
          console.log(
            `   ${chalk.cyan('flui ssh worker-1')} - SSH to worker node`,
          );
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
                    '⚠ OIDC not ready — run `flui env force-ready` to retry bootstrap',
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

      if (firewallId) {
        try {
          spinner = ora('Cleaning up orphaned firewall...').start();
          const firewallFactory = app.get(FirewallProviderFactory);
          const firewallService =
            firewallFactory.getFirewallProviderOrFail(cloudProvider);
          const firewallRepo = app.get(CliFirewallRepository);

          await firewallService.deleteFirewall(firewallId);
          await firewallRepo.delete(firewallId);

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
