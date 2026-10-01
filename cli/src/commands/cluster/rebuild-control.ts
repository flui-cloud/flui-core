import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import {
  RebuildPlan,
  appsToAttempt,
  followRebuild,
  printRebuildPlan,
} from '../../lib/cluster-rebuild-view';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt } from '../../lib/prompts';

interface PreviousControl {
  id: string;
  name: string;
  status: string;
  retired: boolean;
  applications: number;
}

interface ControlRestorePlan extends RebuildPlan {
  candidates: PreviousControl[];
}

const PLAN_PATH = '/infrastructure/clusters/control-restore/plan';
const planPath = (from?: string) =>
  from ? `${PLAN_PATH}?from=${encodeURIComponent(from)}` : PLAN_PATH;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default class ClusterRebuildControl extends Command {
  static readonly description =
    'Bring back the applications that ran on the control cluster of the installation this one was ' +
    'restored from: after a platform backup is loaded into a new installation, each application is ' +
    're-created on its control cluster with its data restored from the backups, databases first.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --plan',
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --from control-cluster --include-stopped --yes',
  ];

  static readonly flags = {
    from: Flags.string({
      description:
        'The earlier control cluster, name or ID — needed only when more than one still has applications',
    }),
    plan: Flags.boolean({
      description: 'Show what would happen and stop',
      default: false,
    }),
    'include-stopped': Flags.boolean({
      description:
        'Also restore applications that were not running when that control cluster was lost',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation',
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Return once the restore is queued',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClusterRebuildControl);

    const configStorage = new ConfigStorage();
    const apiClient = new ApiClient({
      baseUrl: configStorage.getApiUrlOrThrow(),
      apiKey: configStorage.getApiKeyOrThrow(),
    });

    const spinner = ora('Reading the plan…').start();
    let plan: ControlRestorePlan;
    try {
      plan = await this.readPlan(apiClient, flags.from);
      spinner.stop();
    } catch (error: any) {
      spinner.fail('Could not read the plan');
      this.error(error.response?.data?.message ?? error.message, { exit: 1 });
    }

    printRebuildPlan(plan, flags['include-stopped'], 'Restore');

    if (plan.refusals.length > 0) this.refuse(plan);

    const willAttempt = appsToAttempt(plan, flags['include-stopped']);
    if (willAttempt.length === 0) {
      console.log(
        chalk.yellow('\n  Nothing to restore with the current flags.\n'),
      );
      return;
    }

    if (flags.plan) return;

    if (!flags.yes && !(await this.confirmRestore(plan, willAttempt.length))) {
      return;
    }

    const operationId = await this.queueRestore(
      apiClient,
      plan,
      flags['include-stopped'],
    );

    if (flags['no-wait']) {
      console.log(
        chalk.dim(
          `\n  Follow it in the dashboard, or re-run with --plan to see where each application got to.\n`,
        ),
      );
      return;
    }

    const ok = await followRebuild(
      apiClient,
      operationId,
      plan.to.name,
      `flui cluster rebuild-control --from ${plan.from.id}`,
    );
    if (!ok) this.exit(1);
  }

  private refuse(plan: ControlRestorePlan): never {
    console.log(chalk.red('\n  The restore cannot start:\n'));
    for (const r of plan.refusals) console.log(chalk.red(`    • ${r}`));
    if (plan.candidates.length > 1) {
      console.log('');
      for (const c of plan.candidates) {
        console.log(
          `    ${chalk.cyan(c.name)} ${chalk.dim(c.id)} — ${c.applications} application(s)${c.retired ? chalk.dim(', retired') : ''}`,
        );
      }
      console.log(chalk.dim('\n    Pick one with --from <name or ID>.'));
    }
    console.log('');
    this.exit(1);
  }

  private async confirmRestore(
    plan: ControlRestorePlan,
    count: number,
  ): Promise<boolean> {
    console.log('');
    const ok = await confirmPrompt(
      chalk.yellow(
        `  Restore ${count} application(s) from ${plan.from.name} onto ${plan.to.name}?`,
      ),
      false,
    );
    if (!ok) console.log(chalk.dim('\n  Cancelled.\n'));
    return ok;
  }

  private async queueRestore(
    apiClient: ApiClient,
    plan: ControlRestorePlan,
    includeStopped: boolean,
  ): Promise<string> {
    const queueSpinner = ora('Queuing the restore…').start();
    try {
      const queued = await apiClient.post<{
        operation_id: string;
        applications: number;
      }>('/infrastructure/clusters/control-restore', {
        from: plan.from.id,
        includeStopped,
      });
      queueSpinner.succeed(
        `Queued — ${queued.applications} application(s), operation ${queued.operation_id}`,
      );
      return queued.operation_id;
    } catch (error: any) {
      queueSpinner.fail('Could not queue the restore');
      this.error(error.response?.data?.message ?? error.message, { exit: 1 });
    }
  }

  /** A retired control is not in the cluster list, so a name is matched against the plan's own candidates. */
  private async readPlan(
    apiClient: ApiClient,
    from?: string,
  ): Promise<ControlRestorePlan> {
    if (!from || UUID.test(from)) {
      return apiClient.get<ControlRestorePlan>(planPath(from));
    }
    const first = await apiClient.get<ControlRestorePlan>(PLAN_PATH);
    const needle = from.toLowerCase();
    const match = first.candidates.find((c) => c.name.toLowerCase() === needle);
    if (!match) {
      const known = first.candidates.map((c) => c.name).join(', ') || 'none';
      throw new Error(
        `No earlier control cluster named "${from}" has applications recorded on it. Known: ${known}`,
      );
    }
    return apiClient.get<ControlRestorePlan>(planPath(match.id));
  }
}
