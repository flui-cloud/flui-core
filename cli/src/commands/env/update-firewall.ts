import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { buildNipBaseDomain } from '../../lib/nip-base-domain.util';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { FirewallProviderFactory } from '../../../../src/modules/providers/core/factories/firewall-provider.factory';
import {
  IFirewallProvider,
  FirewallRule,
} from '../../../../src/modules/providers/interfaces/firewall-provider.interface';
import { CloudProvider } from '../../../../src/modules/providers/enums/cloud-provider.enum';
import { IpDetectionService } from '../../lib/utils/ip-detection';
import { CliFirewallRepository } from '../../lib/repositories/cli-firewall.repository';
import { CONTROL_FIREWALL_RULES } from '../../lib/templates/firewall-rules';
import { printContextBanner } from '../../lib/context-banner';

type ProviderLabel = 'HETZNER' | 'SCALEWAY';

const isSshRule = (r: FirewallRule): boolean =>
  r.direction === 'in' && r.protocol === 'tcp' && r.port === '22';

/** Replace the SSH rule's source IPs in place; add one if absent (other rules untouched). */
function withSshSource(
  baseRules: FirewallRule[],
  sshCidrs: string[],
): FirewallRule[] {
  const rules = baseRules.length ? baseRules : CONTROL_FIREWALL_RULES(sshCidrs);
  if (!rules.some(isSshRule)) {
    return [
      {
        description: 'SSH access for server management',
        direction: 'in',
        protocol: 'tcp',
        port: '22',
        sourceIps: sshCidrs,
      },
      ...rules,
    ];
  }
  return rules.map((r) => (isSshRule(r) ? { ...r, sourceIps: sshCidrs } : r));
}

export default class EnvUpdateFirewall extends Command {
  static readonly description =
    'Manage SSH access (port 22) on the control cluster firewall. ' +
    'Updates only the SSH source IPs — every other rule is left untouched. ' +
    'Runs directly against the cloud provider, so it works even when your ' +
    'current IP is locked out.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --ip 203.0.113.42',
    '<%= config.bin %> <%= command.id %> --add --ip 203.0.113.42',
    '<%= config.bin %> <%= command.id %> --remove --ip 198.51.100.5/32',
    '<%= config.bin %> <%= command.id %> --list',
  ];

  static readonly flags = {
    ip: Flags.string({
      description:
        'Source IP/CIDR or comma-separated list (default: auto-detect current IP)',
      required: false,
    }),
    add: Flags.boolean({
      description:
        'Add the IP(s) to the existing SSH allowlist (keeps current entries)',
      default: false,
      exclusive: ['remove', 'list'],
    }),
    remove: Flags.boolean({
      description: 'Remove the IP(s) from the SSH allowlist',
      default: false,
      exclusive: ['add', 'list'],
    }),
    list: Flags.boolean({
      description: 'Show the current SSH allowlist and exit (no changes)',
      default: false,
      exclusive: ['add', 'remove'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvUpdateFirewall);
    printContextBanner();
    let spinner = ora('Loading cluster information...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const ipService = app.get(IpDetectionService);
      const firewallFactory = app.get(FirewallProviderFactory);
      const firewallRepo = app.get(CliFirewallRepository);

      const cluster = await controlService.getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
        console.log(chalk.dim('Create one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        return;
      }
      spinner.succeed(`Cluster found (${cluster.provider})`);

      const providerEnum = (
        cluster.provider || ''
      ).toLowerCase() as CloudProvider;
      if (!firewallFactory.supportsFirewall(providerEnum)) {
        this.explainNoCloudFirewall(providerEnum);
        return;
      }
      const firewallService =
        firewallFactory.getFirewallProviderOrFail(providerEnum);
      const providerLabel = providerEnum.toUpperCase() as
        | 'HETZNER'
        | 'SCALEWAY';

      spinner = ora('Finding firewall...').start();
      const existingFirewall = await this.findFirewall(
        firewallRepo,
        firewallService,
        cluster,
        providerLabel,
        spinner,
      );

      if (flags.list) {
        await this.showAllowlist(firewallService, existingFirewall, spinner);
        return;
      }

      if ((flags.add || flags.remove) && !existingFirewall) {
        spinner.fail('No firewall found for this cluster');
        console.log(
          chalk.dim(
            '\nRun `flui env update-firewall` (no flags) to create one first.\n',
          ),
        );
        return;
      }

      const sourceCidrs = await this.resolveSourceCidrs(
        ipService,
        flags.ip,
        spinner,
      );

      const finalSshCidrs = existingFirewall
        ? await this.updateAllowlist(
            firewallService,
            firewallRepo,
            existingFirewall,
            cluster,
            providerLabel,
            sourceCidrs,
            flags,
          )
        : await this.createFirewall(
            firewallService,
            firewallRepo,
            cluster,
            providerLabel,
            sourceCidrs,
          );

      if (!finalSshCidrs) return; // a guard (no-change / lockout) already reported
      this.printSummary(cluster, providerLabel, finalSshCidrs);
    } catch (error) {
      spinner.fail('Failed to configure firewall');
      console.log(chalk.red('\n❌ Error:\n'));
      console.log(
        `   ${error instanceof Error ? error.message : String(error)}\n`,
      );
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  /** Locate the cluster firewall, adopting/disambiguating unlinked ones by master attachment. */
  private async findFirewall(
    firewallRepo: CliFirewallRepository,
    firewallService: IFirewallProvider,
    cluster: any,
    providerLabel: ProviderLabel,
    spinner: Ora,
  ): Promise<any> {
    const linked = await firewallRepo.findByClusterId(cluster.id);
    if (linked) return linked;

    const byProvider = await firewallRepo.findByProvider(providerLabel);
    if (byProvider.length === 0) return null;
    if (byProvider.length === 1) {
      spinner.text = `Adopting unlinked ${providerLabel} firewall ${byProvider[0].name}`;
      return byProvider[0];
    }

    const masterIds = (cluster.nodes || [])
      .filter((n: any) => n.nodeType === 'master')
      .map((n: any) =>
        String(n.providerResourceId || '')
          .split(':')
          .at(-1),
      )
      .filter(Boolean);

    spinner.text = `Disambiguating ${byProvider.length} firewall candidates by master attachment...`;
    const matches: any[] = [];
    for (const fw of byProvider) {
      const details = await firewallService
        .getFirewall(fw.id)
        .catch(() => null);
      if (!details) continue;
      const attached = new Set(details.appliedTo.map((a) => a.serverId));
      if (masterIds.some((m: string) => attached.has(m))) matches.push(fw);
    }

    if (matches.length === 1) {
      spinner.text = `Found attached firewall ${matches[0].name}`;
      return matches[0];
    }
    if (matches.length === 0) {
      spinner.fail('No firewall currently attached to the cluster master');
      this.exit(1);
    }
    spinner.fail('Multiple firewalls attached, cannot disambiguate');
    for (const f of matches) this.log(`  - ${f.name} (${f.id})`);
    this.exit(1);
  }

  private async sshSourceOf(
    firewallService: IFirewallProvider,
    firewall: any,
  ): Promise<{ rules: FirewallRule[]; sshCidrs: string[] }> {
    const live = await firewallService
      .getFirewall(firewall.id)
      .catch(() => null);
    const rules: FirewallRule[] =
      (live?.rules?.length ? live.rules : firewall.rules) ?? [];
    return { rules, sshCidrs: rules.find(isSshRule)?.sourceIps ?? [] };
  }

  private async showAllowlist(
    firewallService: IFirewallProvider,
    firewall: any,
    spinner: Ora,
  ): Promise<void> {
    if (!firewall) {
      spinner.fail('No firewall found for this cluster');
      return;
    }
    spinner.text = 'Reading current firewall rules...';
    const { sshCidrs } = await this.sshSourceOf(firewallService, firewall);
    spinner.succeed(`Firewall ${firewall.name}`);
    console.log(chalk.cyan('\n📋 SSH allowlist (port 22):\n'));
    if (sshCidrs.length === 0) {
      console.log(
        chalk.yellow('   (empty — no source ranges, SSH is unreachable)'),
      );
    } else {
      for (const c of sshCidrs) console.log(`   ${c}`);
    }
    console.log('');
  }

  private async resolveSourceCidrs(
    ipService: IpDetectionService,
    ip: string | undefined,
    spinner: Ora,
  ): Promise<string[]> {
    if (ip) {
      const cidrs = ipService.parseCidrList(ip);
      spinner.info(`Using IP(s): ${cidrs.join(', ')}`);
      return cidrs;
    }
    spinner.stop();
    const detectSpinner = ora('Detecting public IP...').start();
    const publicIp = await ipService.getPublicIp();
    const cidr = ipService.toCidr(publicIp);
    detectSpinner.succeed(`Auto-detected IP: ${cidr}`);
    return [cidr];
  }

  /** Apply add/remove/replace to the SSH allowlist. Returns null when nothing was written. */
  private async updateAllowlist(
    firewallService: IFirewallProvider,
    firewallRepo: CliFirewallRepository,
    firewall: any,
    cluster: any,
    providerLabel: ProviderLabel,
    sourceCidrs: string[],
    flags: { add: boolean; remove: boolean },
  ): Promise<string[] | null> {
    const spinner = ora('Reading current firewall rules...').start();
    const { rules: baseRules, sshCidrs: currentSsh } = await this.sshSourceOf(
      firewallService,
      firewall,
    );

    let finalSshCidrs: string[];
    if (flags.add) {
      finalSshCidrs = [...new Set([...currentSsh, ...sourceCidrs])];
      if (finalSshCidrs.length === currentSsh.length) {
        spinner.info(
          'SSH allowlist already contains the given IP(s) — no change',
        );
        return null;
      }
    } else if (flags.remove) {
      finalSshCidrs = currentSsh.filter((c) => !sourceCidrs.includes(c));
      if (finalSshCidrs.length === currentSsh.length) {
        spinner.info(
          'None of the given IP(s) were in the allowlist — no change',
        );
        return null;
      }
    } else {
      finalSshCidrs = sourceCidrs;
    }

    if (finalSshCidrs.length === 0) {
      spinner.fail('Refusing to leave SSH with no allowed source ranges');
      console.log(
        chalk.yellow(
          '\n⚠️  That change would lock out all SSH access (port 22).\n',
        ),
      );
      console.log(
        chalk.dim(
          '   Keep at least one IP/CIDR, or pass --ip to set a new one.\n',
        ),
      );
      return null;
    }

    const newRules = withSshSource(baseRules, finalSshCidrs);
    spinner.text = 'Updating SSH allowlist...';
    await firewallService.updateFirewallRules(firewall.id, newRules);

    firewall.clusterId = cluster.id;
    firewall.provider = providerLabel;
    firewall.sourceCidrs = finalSshCidrs;
    firewall.rules = newRules;
    await firewallRepo.save(firewall);

    spinner.succeed('SSH allowlist updated');
    return finalSshCidrs;
  }

  private async createFirewall(
    firewallService: IFirewallProvider,
    firewallRepo: CliFirewallRepository,
    cluster: any,
    providerLabel: ProviderLabel,
    sourceCidrs: string[],
  ): Promise<string[]> {
    const spinner = ora('Creating firewall...').start();
    const firewallName = `flui-control-${cluster.id}`;
    const rules = CONTROL_FIREWALL_RULES(sourceCidrs);

    const result = await firewallService.createFirewall({
      name: firewallName,
      labels: [
        { key: 'managed-by', value: 'flui-cloud' },
        { key: 'flui-resource-type', value: 'firewall' },
        { key: 'flui-cluster-id', value: cluster.id },
        { key: 'flui-cluster-type', value: 'control' },
      ],
      rules,
      applyToLabelSelector: `flui-cluster-id=${cluster.id}`,
    });

    const serverIds = (cluster.nodes || [])
      .map((n: any) => n.providerResourceId)
      .filter((x: any): x is string => typeof x === 'string' && x.length > 0);

    if (serverIds.length > 0) {
      await firewallService.applyToServers(result.firewallId, serverIds);
    }

    await firewallRepo.save({
      id: result.firewallId,
      name: firewallName,
      provider: providerLabel,
      clusterId: cluster.id,
      rules,
      appliedToServerIds: serverIds,
      sourceCidrs,
      labels: [
        { key: 'managed-by', value: 'flui-cloud' },
        { key: 'flui-cluster-id', value: cluster.id },
      ],
    });

    spinner.succeed('Firewall created successfully');
    return sourceCidrs;
  }

  /**
   * This command drives a *cloud* firewall (Hetzner/Scaleway security groups) to
   * change the SSH allowlist. Providers without one are not unprotected — on BYOS
   * Flui runs a default-drop nftables firewall on the host itself — so the message
   * names what is actually managed, and where SSH is deliberately left open.
   */
  private explainNoCloudFirewall(provider: CloudProvider): void {
    console.log(
      chalk.yellow(
        `\n⚠️  ${provider} has no cloud firewall API, so the SSH allowlist cannot be changed from here.\n`,
      ),
    );
    console.log(
      chalk.dim(
        '   Your host firewall is still managed by Flui — a default-drop\n' +
          '   nftables ruleset applied directly on the server. Inspect it with:',
      ),
    );
    console.log(`   ${chalk.cyan('flui env firewall status')}`);
    console.log(`   ${chalk.cyan('flui env firewall apply')}\n`);
    console.log(
      chalk.dim(
        '   SSH stays reachable from any address on this backend, on purpose:\n' +
          '   the host has no out-of-band console, so a bad allowlist would lock\n' +
          '   you out for good. Restrict port 22 at your provider or in sshd.\n',
      ),
    );
  }

  private printSummary(
    cluster: any,
    providerLabel: ProviderLabel,
    finalSshCidrs: string[],
  ): void {
    console.log(chalk.cyan('\n📋 Firewall Configuration:\n'));
    console.log(`   ${chalk.bold('Provider:')}      ${providerLabel}`);
    console.log(`   ${chalk.bold('Cluster:')}       ${cluster.name}`);
    console.log(
      `   ${chalk.bold('SSH allowlist:')} ${finalSshCidrs.join(', ')}`,
    );
    console.log('');
    console.log(chalk.bold('Exposed Services:'));
    console.log(`   SSH:         ${cluster.masterIpAddress}:22`);
    const baseDomain = buildNipBaseDomain(
      cluster.masterIpAddress,
      cluster.nipHostnameToken,
    );
    console.log(`   Flui API:    https://api.${baseDomain}`);
    console.log(`   Dashboard:   https://app.${baseDomain}`);
    console.log(
      `   Grafana/Prometheus/Loki: cluster-internal (kubectl port-forward)`,
    );
    console.log('');
  }
}
