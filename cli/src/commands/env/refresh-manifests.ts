import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { printContextBanner } from '../../lib/context-banner';

interface Entry {
  name: string;
  action: 'replace' | 'add' | 'unchanged' | 'skip';
  reason?: string;
  placeholders?: string[];
}

interface Plan {
  ref: string;
  planId: string;
  indexed: boolean;
  entries: Entry[];
  wrote?: string[];
  backupPath?: string;
}

/**
 * The manifests on the master are what k3s re-applies at every start, so they
 * decide what the cluster goes back to. They are written once, at install, and
 * nothing has ever brought them forward — which is why an installation made
 * months ago still carries the alert rules of that day, with every annotation's
 * `$labels` blanked out by the renderer of the time.
 *
 * This shows what a release would change and, by default, changes nothing.
 */
function verbFor(action: Entry['action'], applied: boolean): string {
  if (applied) return chalk.green('wrote  ');
  return action === 'add' ? chalk.cyan('add    ') : chalk.yellow('replace');
}

export default class EnvRefreshManifests extends Command {
  static readonly description =
    'Bring the manifests the cluster restarts from into line with a release. Shows what would change and writes nothing unless asked.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --ref v0.13.0',
    '<%= config.bin %> <%= command.id %> --apply --plan 3f9c2a1',
  ];

  static readonly flags = {
    ref: Flags.string({
      description:
        'The release of the bootstrap manifests to compare against. Defaults to the one this CLI pins.',
    }),
    only: Flags.string({
      multiple: true,
      description: 'Limit to these files, by name (e.g. 04c-vmalert.yaml).',
    }),
    apply: Flags.boolean({
      default: false,
      description: 'Write the plan. Needs --plan from a dry run.',
    }),
    plan: Flags.string({ description: 'The plan id a dry run printed.' }),
    'allow-stateful-image-change': Flags.boolean({
      default: false,
      description:
        'Permit a file that changes the image of a workload holding a volume. Read the release notes first.',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvRefreshManifests);
    printContextBanner();

    if (flags.apply && !flags.plan) {
      this.log('');
      this.log(
        `   ${chalk.yellow('--apply needs --plan <id>')} ${chalk.dim('from a dry run of the same release.')}`,
      );
      this.log(chalk.dim('   Run it without --apply first.\n'));
      this.exit(1);
      return;
    }

    const spinner = ora(
      flags.apply ? 'Applying...' : 'Comparing the master with the release...',
    ).start();

    try {
      const { api } = await openControlPlane(await getNestApp());
      const body = {
        ref: flags.ref,
        only: flags.only,
        allowStatefulImageChange: flags['allow-stateful-image-change'],
        ...(flags.apply ? { planId: flags.plan } : {}),
      };
      // It runs a short job on the master and waits for it.
      const result = await api.post<Plan>(
        `/platform/updates/manifests/${flags.apply ? 'apply' : 'plan'}`,
        body,
        { timeoutMs: 300_000 },
      );
      spinner.stop();

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2));
        return;
      }
      this.render(result, flags.apply);
    } catch (error) {
      spinner.fail(
        flags.apply ? 'Could not apply' : 'Could not read the master',
      );
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private render(plan: Plan, applied: boolean): void {
    const changing = plan.entries.filter(
      (e) => e.action === 'replace' || e.action === 'add',
    );
    const left = plan.entries.filter((e) => e.action === 'skip');
    const same = plan.entries.filter((e) => e.action === 'unchanged').length;

    this.log('');
    this.log(`   ${chalk.dim('release')} ${chalk.bold(plan.ref)}`);
    this.log('');

    this.renderChanging(changing, same, applied);
    this.renderLeftAlone(left);

    if (!plan.indexed) {
      const why =
        ', so nothing can be added; files already present are still compared.';
      this.log('');
      this.log(
        `   ${chalk.yellow('This release ships no manifest index')}${chalk.dim(why)}`,
      );
    }

    this.log('');
    if (applied) {
      this.renderApplied(plan);
      return;
    }
    this.renderNextStep(plan, changing.length > 0);
  }

  private renderChanging(
    changing: Entry[],
    same: number,
    applied: boolean,
  ): void {
    if (changing.length === 0) {
      const rest = `${same} file(s) already match this release.`;
      this.log(`   ${chalk.green('Nothing to change.')} ${chalk.dim(rest)}`);
      return;
    }
    for (const e of changing) {
      this.log(`   ${verbFor(e.action, applied)} ${e.name}`);
    }
    if (same > 0) {
      this.log(chalk.dim(`   ${same} other file(s) already match.`));
    }
  }

  /**
   * The honest half, and the reason this is safe to run: what it will not
   * touch, said out loud, one line each.
   */
  private renderLeftAlone(left: Entry[]): void {
    if (left.length === 0) return;
    this.log('');
    this.log(chalk.dim('   left alone'));
    for (const e of left) {
      this.log(
        `     ${chalk.dim(e.name.padEnd(28))} ${chalk.dim(e.reason ?? '')}`,
      );
    }
  }

  private renderApplied(plan: Plan): void {
    if (plan.wrote?.length) {
      const where = `A copy of what was replaced is on the master at ${plan.backupPath}.`;
      this.log(`   ${chalk.green('Done.')} ${chalk.dim(where)}`);
    } else {
      this.log(chalk.dim('   Nothing needed writing.'));
    }
    this.log(
      chalk.dim(
        '   k3s applies these on its own. A restart or a reboot now keeps them.\n',
      ),
    );
  }

  private renderNextStep(plan: Plan, anythingToDo: boolean): void {
    if (!anythingToDo) {
      this.log('');
      return;
    }
    const ref = plan.ref ? ` --ref ${plan.ref}` : '';
    const command = `flui env refresh-manifests${ref} --apply --plan ${plan.planId}`;
    this.log(`   ${chalk.dim('plan')} ${chalk.bold(plan.planId)}`);
    this.log(chalk.dim(`   To apply: ${command}\n`));
  }
}
