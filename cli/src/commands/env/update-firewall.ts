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
import { ApiClient, ApiError } from '../../lib/api-client';
import { openControlPlane } from '../../lib/control-plane-api';
import {
  AllowlistChange,
  isSshRule,
  nextSshSources,
  sshSourcesOf,
  withSshSource,
} from '../../lib/firewall/ssh-allowlist';

type ProviderLabel = 'HETZNER' | 'SCALEWAY';

/** The rules Flui keeps for this cluster, as the API holds them. */
interface SavedFirewall {
  id: string;
  desiredRules: FirewallRule[];
}

type SavedRules =
  | { kind: 'found'; api: ApiClient; firewall: SavedFirewall }
  | { kind: 'absent' }
  | { kind: 'unreachable'; reason: string };

export default class EnvUpdateFirewall extends Command {
  static readonly description =
    'Manage SSH access (port 22) on the control cluster firewall. ' +
    'Updates only the SSH source IPs — every other rule is left untouched. ' +
    'Writes the rules Flui keeps, so a later reconcile does not undo it; when ' +
    'the Flui API does not answer it writes to the cloud provider directly, ' +
    'so it works even when your current IP is locked out, and brings the ' +
    'saved rules in line on the next run.';

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

      const saved = await this.readSavedRules(app, cluster.id);

      if (flags.list) {
        await this.showAllowlist(
          firewallService,
          existingFirewall,
          saved,
          spinner,
        );
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
            saved,
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
    saved: SavedRules,
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
    if (saved.kind === 'found') {
      const kept = sshSourcesOf(saved.firewall.desiredRules);
      const onlyLive = sshCidrs.filter((c) => !kept.includes(c));
      const onlyKept = kept.filter((c) => !sshCidrs.includes(c));
      if (onlyLive.length || onlyKept.length) {
        console.log(
          chalk.yellow(
            '\n   The rules Flui keeps differ from the provider:' +
              (onlyLive.length
                ? `\n   only on the provider: ${onlyLive.join(', ')}`
                : '') +
              (onlyKept.length
                ? `\n   only in Flui:         ${onlyKept.join(', ')}`
                : '') +
              `\n   Run ${chalk.cyan('flui env update-firewall --add --ip <cidr>')} to keep an address in both.`,
          ),
        );
      }
    } else if (saved.kind === 'unreachable') {
      console.log(
        chalk.dim(
          `\n   The rules Flui keeps could not be read (${saved.reason}).`,
        ),
      );
    }
    console.log('');
  }

  /**
   * The saved rules, when the API answers. Only a missing record or an API
   * that cannot be reached lets the command fall back to the provider; a
   * refusal (no permission) stops it, so the fallback is never a way around
   * the API's own checks.
   */
  private async readSavedRules(
    app: Awaited<ReturnType<typeof getNestApp>>,
    clusterId: string,
  ): Promise<SavedRules> {
    let api: ApiClient;
    try {
      ({ api } = await openControlPlane(app));
    } catch (error) {
      return {
        kind: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const firewall = await api.get<SavedFirewall>(
        `/firewalls/cluster/${clusterId}`,
      );
      return { kind: 'found', api, firewall };
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        return { kind: 'absent' };
      }
      if (
        error instanceof ApiError &&
        error.statusCode !== undefined &&
        error.statusCode < 500
      ) {
        throw error;
      }
      return {
        kind: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
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
    saved: SavedRules,
  ): Promise<string[] | null> {
    const spinner = ora('Reading current firewall rules...').start();
    const { rules: liveRules, sshCidrs: liveSsh } = await this.sshSourceOf(
      firewallService,
      firewall,
    );
    const savedSsh =
      saved.kind === 'found' ? sshSourcesOf(saved.firewall.desiredRules) : [];
    let change: AllowlistChange = 'replace';
    if (flags.add) change = 'add';
    else if (flags.remove) change = 'remove';
    const { current, next: finalSshCidrs } = nextSshSources(
      savedSsh,
      liveSsh,
      sourceCidrs,
      change,
    );

    const inLine =
      saved.kind !== 'found' ||
      (savedSsh.length === liveSsh.length &&
        savedSsh.every((c) => liveSsh.includes(c)));
    const unchanged =
      finalSshCidrs.length === current.length &&
      finalSshCidrs.every((c) => current.includes(c));
    if (unchanged && inLine && !firewall.savedRulesPending) {
      spinner.info(
        change === 'remove'
          ? 'None of the given IP(s) were in the allowlist — no change'
          : 'SSH allowlist already contains the given IP(s) — no change',
      );
      return null;
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

    let newRules: FirewallRule[];
    let pending = false;
    if (saved.kind === 'found') {
      spinner.text = 'Updating the rules Flui keeps...';
      newRules = withSshSource(saved.firewall.desiredRules, finalSshCidrs);
      try {
        await saved.api.put(`/firewalls/${saved.firewall.id}/desired-rules`, {
          desiredRules: newRules,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.statusCode !== undefined &&
          error.statusCode < 500
        ) {
          throw error;
        }
        spinner.text = 'Flui API did not apply it — updating the provider...';
        await firewallService.updateFirewallRules(firewall.id, newRules);
        pending = true;
      }
    } else {
      newRules = withSshSource(liveRules, finalSshCidrs);
      spinner.text = 'Updating SSH allowlist...';
      await firewallService.updateFirewallRules(firewall.id, newRules);
      pending = saved.kind === 'unreachable';
    }

    firewall.clusterId = cluster.id;
    firewall.provider = providerLabel;
    firewall.sourceCidrs = finalSshCidrs;
    firewall.rules = newRules;
    firewall.savedRulesPending = pending;
    await firewallRepo.save(firewall);

    spinner.succeed('SSH allowlist updated');
    if (pending) {
      console.log(
        chalk.yellow(
          '\n⚠️  Written to the provider only: the Flui API did not answer.\n' +
            '   Its next reconcile could put the old allowlist back. Run this\n' +
            `   command again once the API answers (e.g. ${chalk.cyan('flui env update-firewall --list')}\n` +
            '   shows it) to bring the rules Flui keeps in line.\n',
        ),
      );
    }
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
