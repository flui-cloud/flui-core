import { readFileSync } from 'node:fs';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { ProviderFactory } from 'src/modules/providers/core/factories/provider.factory';
import { FirewallProviderFactory } from 'src/modules/providers/core/factories/firewall-provider.factory';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { CliClusterRepository } from '../../lib/repositories/cli-cluster.repository';
import { ConfigStorage } from '../../lib/config-storage';
import { isCompoundProvider } from '../../lib/provider-credential-schemas';
import { printContextBanner } from '../../lib/context-banner';
import { confirmPrompt } from '../../lib/prompts';
import { refuseToAsk, setNonInteractive } from '../../lib/non-interactive';
import { stdinValue } from '../../lib/stdin-value';
import { parseLedger, LedgerParseError } from '../../lib/scrub/ledger';
import { planScrub, type DiscoveredResource } from '../../lib/scrub/plan';
import { discoverResources } from '../../lib/scrub/discovery';
import { renderPlan, type Palette } from '../../lib/scrub/render';

const PALETTE: Palette = {
  bold: (text) => chalk.bold(text),
  dim: (text) => chalk.dim(text),
  cyan: (text) => chalk.cyan(text),
  warn: (text) => chalk.yellow(text),
  danger: (text) => chalk.red(text),
};

/**
 * Clean up after a managed installation that never finished.
 *
 * `app.flui.cloud` provisions on the customer's own provider account with the
 * customer's own token. When the worker dies mid-run it dies holding that
 * token, so it cannot finish the teardown — and what is left behind is a
 * server, a firewall and a couple of SSH keys, billing to an account we have no
 * access to. Until now the customer got a list of those and nothing to do with
 * it. This is the something.
 *
 * It is a tool for after the fact, like `env orphan-volumes`: the cluster it
 * would have talked to was never finished, and `app.flui.cloud` is deliberately
 * not the customer's control plane. So it talks to the provider directly, with
 * the credentials in this machine's own profile, and asks nothing of any API.
 *
 * The list decides *what*; the provider decides *whether*. See `lib/scrub/plan`
 * for why neither is trusted on its own.
 */
export default class EnvScrub extends Command {
  static readonly description =
    'Remove the provider resources left behind by an abandoned app.flui.cloud run, using the resource list that run reported';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --ledger ./flui-run.json',
    'cat flui-run.json | <%= config.bin %> <%= command.id %> --stdin',
    '<%= config.bin %> <%= command.id %> --ledger ./flui-run.json --delete',
  ];

  static readonly flags = {
    ledger: Flags.string({
      description:
        'Path to the resource list the funnel reported (JSON). Use --stdin to pipe it instead.',
      exclusive: ['stdin'],
    }),
    stdin: Flags.boolean({
      description: 'Read the resource list from standard input',
      default: false,
      exclusive: ['ledger'],
    }),
    provider: Flags.string({
      char: 'p',
      description:
        'Only look at one provider (default: every provider configured in this profile)',
      options: ['hetzner', 'scaleway'],
    }),
    delete: Flags.boolean({
      description:
        'Actually delete the resources the plan resolved. Without it, nothing is touched.',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation prompt',
      default: false,
    }),
    'non-interactive': Flags.boolean({
      description: 'Never prompt; fail instead of asking',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvScrub);
    if (flags['non-interactive']) setNonInteractive(true);
    printContextBanner();

    const ledger = this.readLedger(flags.ledger, flags.stdin);
    const forRun = ledger.runId ? ` for run ${ledger.runId}` : '';
    console.log(
      chalk.dim(
        `   Resource list${forRun}: ` +
          `${ledger.entries.length} resource(s)` +
          (ledger.ignored > 0 ? `, ${ledger.ignored} unreadable row(s)` : ''),
      ),
    );
    console.log('');

    const targets = this.resolveProviders(flags.provider);

    const app = await getNestApp();
    try {
      const providerFactory = app.get(ProviderFactory);
      const firewallFactory = app.get(FirewallProviderFactory);
      const clusterRepo = app.get(CliClusterRepository);

      const spinner = ora('Asking the provider what exists...').start();
      const discovered: DiscoveredResource[] = [];
      const blind: string[] = [];
      for (const target of targets) {
        const found = await discoverResources(
          target,
          providerFactory,
          firewallFactory,
        );
        discovered.push(...found.resources);
        blind.push(...found.failures);
      }
      spinner.succeed(
        `Provider answered — ${discovered.length} resource(s) visible`,
      );

      const clusters = await clusterRepo.find();
      const plan = planScrub({
        ledger: ledger.entries,
        discovered,
        knownClusterIds: clusters.map((c) => c.id).filter(Boolean),
      });

      for (const line of renderPlan(plan, blind, PALETTE)) console.log(line);

      if (plan.removals.length === 0) {
        console.log(chalk.green('\n✅ Nothing to remove.\n'));
        this.finish(plan.refusals.length);
        return;
      }

      if (!flags.delete) {
        console.log(
          chalk.dim(
            '\n   Re-run with --delete to remove the resources marked "remove". Nothing else is ever touched.\n',
          ),
        );
        this.finish(plan.refusals.length);
        return;
      }

      // A blind spot is not an empty account. Deleting on a partial view is how
      // "it said nothing was there" turns into a deleted namesake.
      if (blind.length > 0) {
        console.log(
          chalk.red(
            '\n   Refusing to delete: part of the account could not be listed, so the plan is incomplete.\n',
          ),
        );
        this.exit(1);
      }

      if (!flags.yes) {
        refuseToAsk(
          'confirmation to delete provider resources',
          'Pass --yes to confirm up front.',
        );
        const confirmed = await confirmPrompt(
          chalk.yellow(
            `Delete ${plan.removals.length} resource(s) from your provider account? This is irreversible`,
          ),
          false,
        );
        if (!confirmed) {
          console.log(chalk.green('\n✅ Nothing was deleted\n'));
          return;
        }
      }

      const failed = await this.removeAll(
        plan.removals.map((d) => d.match as DiscoveredResource),
        providerFactory,
        firewallFactory,
      );
      this.finish(plan.refusals.length + failed);
    } finally {
      await closeNestApp();
    }
  }

  private readLedger(path: string | undefined, useStdin: boolean) {
    if (!path && !useStdin) {
      this.error(
        'Nothing to work from. Pass --ledger <file> with the resource list the funnel reported, or pipe it with --stdin.',
      );
    }
    let raw: string;
    try {
      raw = useStdin ? stdinValue() : readFileSync(path as string, 'utf-8');
    } catch (error) {
      return this.error(
        `Could not read the resource list: ${(error as Error).message}`,
      );
    }
    try {
      return parseLedger(raw);
    } catch (error) {
      if (error instanceof LedgerParseError) return this.error(error.message);
      throw error;
    }
  }

  private resolveProviders(only: string | undefined): CloudProvider[] {
    if (only) return [only as CloudProvider];
    const config = new ConfigStorage();
    const configured = [CloudProvider.HETZNER, CloudProvider.SCALEWAY].filter(
      (p) =>
        isCompoundProvider(p) ? config.hasCredentials(p) : config.hasToken(p),
    );
    if (configured.length === 0) {
      this.error(
        'No provider credentials in this profile. Add the token you used in the funnel first:\n' +
          '  flui config set hetzner --stdin',
      );
    }
    return configured;
  }

  private async removeAll(
    resources: readonly DiscoveredResource[],
    providerFactory: ProviderFactory,
    firewallFactory: FirewallProviderFactory,
  ): Promise<number> {
    let deleted = 0;
    let failed = 0;
    for (const resource of resources) {
      const spinner = ora(
        `Deleting ${resource.kind} ${resource.name}...`,
      ).start();
      try {
        await this.remove(resource, providerFactory, firewallFactory);
        spinner.succeed(`Deleted ${resource.kind} ${resource.name}`);
        deleted++;
      } catch (error) {
        spinner.fail(
          `Failed to delete ${resource.kind} ${resource.name}: ${(error as Error).message}`,
        );
        failed++;
      }
    }
    console.log('');
    console.log(
      chalk.green(`✅ Deleted ${deleted} resource(s)`) +
        (failed > 0 ? chalk.red(` · ${failed} failed`) : ''),
    );
    console.log('');
    return failed;
  }

  private async remove(
    resource: DiscoveredResource,
    providerFactory: ProviderFactory,
    firewallFactory: FirewallProviderFactory,
  ): Promise<void> {
    const provider = resource.provider as CloudProvider;
    const svc = providerFactory.getProvider(provider);
    switch (resource.kind) {
      case 'server':
        await svc.deleteServer({
          server_id: resource.providerId,
          provider,
          force: true,
          reason: 'flui env scrub',
        });
        return;
      case 'volume':
        if (svc.detachVolume) {
          try {
            await svc.detachVolume(resource.providerId);
          } catch {
            // Already detached, or the server it was on is gone: the delete
            // below is what actually has to succeed.
          }
        }
        if (!svc.deleteVolume) {
          throw new Error(`${provider} cannot delete volumes`);
        }
        await svc.deleteVolume(resource.providerId);
        return;
      case 'firewall':
        await firewallFactory
          .getFirewallProviderOrFail(provider)
          .deleteFirewall(resource.providerId);
        return;
      case 'network':
        if (!svc.deleteVNet) throw new Error(`${provider} cannot delete VNets`);
        await svc.deleteVNet(resource.providerId);
        return;
      case 'ssh-key':
        if (!svc.deleteSSHKey) {
          throw new Error(`${provider} cannot delete SSH keys`);
        }
        await svc.deleteSSHKey(resource.providerId);
        return;
    }
  }

  /**
   * A refusal is money still on the account that nobody resolved, so it has to
   * be visible to a script and not only to a reader.
   */
  private finish(unresolved: number): void {
    if (unresolved > 0) {
      console.log(
        chalk.yellow(
          `   ${unresolved} entr${unresolved === 1 ? 'y' : 'ies'} could not be resolved — look at them before you close this.\n`,
        ),
      );
      this.exit(1);
    }
  }
}
