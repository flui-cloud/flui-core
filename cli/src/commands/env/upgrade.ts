import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { printContextBanner } from '../../lib/context-banner';
import {
  UpgradeOperationView,
  UpgradePlanView,
  WITHOUT_BACKUP_SENTENCE,
  backupAcknowledgement,
  renderUpgradeOperation,
  renderUpgradePlan,
} from '../../lib/platform-upgrade-view';
import { confirmByTypingPrompt } from '../../lib/prompts';

type ControlPlaneApi = Awaited<ReturnType<typeof openControlPlane>>['api'];

interface UpgradeFlags {
  to?: string;
  plan?: string;
  apply: boolean;
  cluster?: string;
  'without-backup': boolean;
  json: boolean;
}

type UpgradeMode = 'resume' | 'apply' | 'plan';

const MODE_LABELS: Record<UpgradeMode, { start: string; fail: string }> = {
  resume: { start: 'Resuming...', fail: 'Could not resume' },
  apply: {
    start: 'Starting the update...',
    fail: 'Could not start the update',
  },
  plan: { start: 'Planning the update...', fail: 'Could not plan the update' },
};

function modeOf(flags: { resume?: string; apply: boolean }): UpgradeMode {
  if (flags.resume) return 'resume';
  if (flags.apply) return 'apply';
  return 'plan';
}

export default class EnvUpgrade extends Command {
  static readonly description =
    'Update this installation to a new Flui release: back up, bring the system manifests forward, roll out the platform components, upgrade K3s and check the result. Shows the plan and changes nothing unless asked.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --to 0.20.0',
    '<%= config.bin %> <%= command.id %> --to 0.20.0 --plan a1b2c3d4e5f60718 --apply',
    '<%= config.bin %> <%= command.id %> --resume 6f1c2d34-...',
  ];

  static readonly flags = {
    to: Flags.string({
      description: 'The release to update to. Defaults to the one on offer.',
    }),
    plan: Flags.string({ description: 'The plan id a dry run printed.' }),
    apply: Flags.boolean({
      default: false,
      description: 'Apply the plan. Needs --plan from a dry run.',
    }),
    cluster: Flags.string({
      description:
        'Show only this cluster (id or name) in the plan. The update itself always covers every cluster.',
    }),
    'without-backup': Flags.boolean({
      default: false,
      description: `Skip the backup taken first. You type the sentence "${WITHOUT_BACKUP_SENTENCE}" at the prompt, or give it with --acknowledge; it is recorded in the operation and the audit log.`,
    }),
    acknowledge: Flags.string({
      description:
        'With --without-backup and no terminal to type in: the sentence, exactly.',
      dependsOn: ['without-backup'],
    }),
    resume: Flags.string({
      description: 'Resume a planned update that stopped, by its operation id.',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvUpgrade);
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

    const acknowledgement =
      flags.apply && flags['without-backup']
        ? await this.askAcknowledgement(flags.acknowledge)
        : undefined;

    const labels = MODE_LABELS[modeOf(flags)];
    const spinner = ora(labels.start).start();
    try {
      const { api } = await openControlPlane(await getNestApp());
      if (flags.resume) {
        await this.resume(api, spinner, flags.resume, flags.json);
      } else if (flags.apply) {
        await this.apply(api, spinner, flags, acknowledgement);
      } else {
        await this.plan(api, spinner, flags);
      }
    } catch (error) {
      spinner.fail(labels.fail);
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private async askAcknowledgement(
    acknowledge: string | undefined,
  ): Promise<string> {
    const answer = await backupAcknowledgement({
      withoutBackup: true,
      acknowledge,
      canAsk: Boolean(process.stdin.isTTY),
      ask: async (sentence) =>
        (await confirmByTypingPrompt(
          `   ${chalk.yellow('To go without a backup, type')} "${sentence}"`,
          sentence,
        ))
          ? sentence
          : '',
    });
    if (!answer.acknowledgement) {
      this.log(`\n   ${chalk.yellow(answer.error ?? '')}\n`);
      this.exit(1);
    }
    return answer.acknowledgement;
  }

  private async resume(
    api: ControlPlaneApi,
    spinner: Ora,
    operationId: string,
    json: boolean,
  ): Promise<void> {
    const op = await api.post<UpgradeOperationView>(
      `/platform/updates/${encodeURIComponent(operationId)}/resume`,
      {},
    );
    spinner.stop();
    this.print(json, op, () => renderUpgradeOperation(op));
  }

  private async apply(
    api: ControlPlaneApi,
    spinner: Ora,
    flags: UpgradeFlags,
    acknowledgement: string | undefined,
  ): Promise<void> {
    const targetVersion =
      flags.to ??
      (await api.get<{ availableVersion: string | null }>('/platform/updates'))
        .availableVersion;
    if (!targetVersion) {
      spinner.fail('No release is on offer');
      this.exit(1);
      return;
    }
    const op = await api.post<UpgradeOperationView>(
      '/platform/updates',
      {
        targetVersion,
        planId: flags.plan,
        ...(acknowledgement ? { withoutBackup: true, acknowledgement } : {}),
      },
      { timeoutMs: 600_000 },
    );
    spinner.stop();
    this.print(flags.json, op, () => [
      ...renderUpgradeOperation(op),
      chalk.dim('   Follow it: flui env upgrade\n'),
    ]);
  }

  private async plan(
    api: ControlPlaneApi,
    spinner: Ora,
    flags: UpgradeFlags,
  ): Promise<void> {
    const current = await api.get<UpgradeOperationView | null>(
      '/platform/updates/current',
    );
    if (current) {
      spinner.stop();
      this.print(flags.json, current, () => renderUpgradeOperation(current));
      return;
    }

    const plan = await api.post<UpgradePlanView>(
      '/platform/updates/plan',
      flags.to ? { targetVersion: flags.to } : {},
      { timeoutMs: 600_000 },
    );
    spinner.stop();
    this.print(flags.json, plan, () =>
      renderUpgradePlan(plan, {
        cluster: flags.cluster,
        withoutBackup: flags['without-backup'],
      }),
    );
  }

  private print(json: boolean, data: unknown, lines: () => string[]): void {
    if (json) {
      this.log(JSON.stringify(data, null, 2));
      return;
    }
    for (const line of lines()) this.log(line);
  }
}
