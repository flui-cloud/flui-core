import { Command, Args, Flags } from '@oclif/core';
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
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { confirmPrompt } from '../../lib/prompts';

export default class ClusterRebuild extends Command {
  static readonly description =
    'Re-materialise the applications of a lost cluster onto a live one, from the records and the backups.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-cluster-3 --to workload-cluster-2 --plan',
    '<%= config.bin %> <%= command.id %> workload-cluster-3 --to workload-cluster-2',
    '<%= config.bin %> <%= command.id %> workload-cluster-3 --to workload-cluster-2 --include-stopped --yes',
  ];

  static readonly args = {
    cluster: Args.string({
      description: 'The lost cluster — name or ID',
      required: true,
    }),
  };

  static readonly flags = {
    to: Flags.string({
      description: 'The live cluster to rebuild onto',
      required: true,
    }),
    plan: Flags.boolean({
      description: 'Show what would happen and stop',
      default: false,
    }),
    'include-stopped': Flags.boolean({
      description:
        'Also rebuild applications that were not running when the cluster was lost',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip the confirmation',
      default: false,
    }),
    'no-wait': Flags.boolean({
      description: 'Return once the rebuild is queued',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterRebuild);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();

    let from: { id: string; name: string };
    let to: { id: string; name: string };
    try {
      from = await resolveClusterRef(args.cluster);
      to = await resolveClusterRef(flags.to);
    } catch (error: any) {
      this.error(error.message, { exit: 1 });
    }

    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey });
    const plan = await this.readPlan(apiClient, from.id, to.id);
    printRebuildPlan(plan, flags['include-stopped']);

    if (plan.refusals.length > 0) {
      console.log(chalk.red('\n  The rebuild cannot start:\n'));
      for (const r of plan.refusals) console.log(chalk.red(`    • ${r}`));
      console.log('');
      this.exit(1);
    }

    const willAttempt = appsToAttempt(plan, flags['include-stopped']);
    if (willAttempt.length === 0) {
      console.log(
        chalk.yellow('\n  Nothing to rebuild with the current flags.\n'),
      );
      return;
    }

    if (flags.plan) return;
    if (!flags.yes && !(await this.confirm(willAttempt.length, to.name))) {
      console.log(chalk.dim('\n  Cancelled.\n'));
      return;
    }

    const operationId = await this.queue(
      apiClient,
      from.id,
      to.id,
      flags['include-stopped'],
    );

    if (flags['no-wait']) {
      console.log(
        chalk.dim(
          `\n  Follow it with \`flui cluster list\` or the dashboard.\n`,
        ),
      );
      return;
    }

    const ok = await followRebuild(
      apiClient,
      operationId,
      to.name,
      `flui cluster rebuild ${args.cluster} --to ${flags.to}`,
    );
    if (!ok) this.exit(1);
  }

  private async readPlan(
    apiClient: ApiClient,
    fromId: string,
    toId: string,
  ): Promise<RebuildPlan> {
    const spinner = ora('Reading the plan…').start();
    try {
      const plan = await apiClient.get<RebuildPlan>(
        `/infrastructure/clusters/${fromId}/rebuild-plan?to=${toId}`,
      );
      spinner.stop();
      return plan;
    } catch (error: any) {
      spinner.fail('Could not read the plan');
      this.error(error.response?.data?.message ?? error.message, { exit: 1 });
    }
  }

  private async confirm(count: number, toName: string): Promise<boolean> {
    console.log('');
    return confirmPrompt(
      chalk.yellow(`  Rebuild ${count} application(s) onto ${toName}?`),
      false,
    );
  }

  private async queue(
    apiClient: ApiClient,
    fromId: string,
    toId: string,
    includeStopped: boolean,
  ): Promise<string> {
    const spinner = ora('Queuing the rebuild…').start();
    try {
      const queued = await apiClient.post<{
        operation_id: string;
        applications: number;
      }>(`/infrastructure/clusters/${fromId}/rebuild`, {
        to: toId,
        includeStopped,
      });
      spinner.succeed(
        `Queued — ${queued.applications} application(s), operation ${queued.operation_id}`,
      );
      return queued.operation_id;
    } catch (error: any) {
      spinner.fail('Could not queue the rebuild');
      this.error(error.response?.data?.message ?? error.message, { exit: 1 });
    }
  }
}
