import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  CronConcurrencyPolicy,
} from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

export default class AppScheduleUpdate extends Command {
  static readonly description =
    'Change a scheduled job: its timing, time zone, command or overlap policy. ' +
    'Only the flags you pass change.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app nightly-cleanup -s "30 3 * * *"',
    '<%= config.bin %> <%= command.id %> my-app nightly-cleanup -x "node dist/tasks/cleanup.js --dry-run"',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    name: Args.string({ description: 'Schedule name', required: true }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    schedule: Flags.string({
      char: 's',
      description: 'Cron expression, 5 fields (e.g. "0 3 * * *")',
    }),
    command: Flags.string({ char: 'x', description: 'Command to run' }),
    timezone: Flags.string({
      char: 't',
      description: 'Time zone, e.g. Europe/Rome',
    }),
    concurrency: Flags.string({
      description: 'What to do when a run is still going at the next tick',
      options: ['Allow', 'Forbid', 'Replace'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScheduleUpdate);
    const body = {
      ...(flags.schedule ? { schedule: flags.schedule } : {}),
      ...(flags.command ? { command: flags.command } : {}),
      ...(flags.timezone ? { timezone: flags.timezone } : {}),
      ...(flags.concurrency
        ? { concurrencyPolicy: flags.concurrency as CronConcurrencyPolicy }
        : {}),
    };
    if (!Object.keys(body).length) {
      this.error(
        'Nothing to change: pass --schedule, --command, --timezone or --concurrency.',
      );
    }
    await changeSchedule(
      this,
      flags.cluster,
      args.app,
      args.name,
      body,
      'Updated',
    );
  }
}

export async function changeSchedule(
  command: Command,
  cluster: string | undefined,
  appRef: string,
  name: string,
  body: Record<string, unknown>,
  done: string,
): Promise<void> {
  const spinner = ora(`Updating "${name}"...`).start();
  try {
    const { id: clusterId } = await resolveClusterRef(cluster);
    const service = await CliAppService.create(clusterId);
    const app = await service.getAppByName(appRef);
    const updated = await service.updateScheduledJob(app.id, name, body);
    const timezone = updated.timezone ? ` (${updated.timezone})` : '';
    spinner.succeed(
      `${done} "${updated.name}": ${updated.schedule}${timezone} — ${updated.enabled ? 'enabled' : 'suspended'}`,
    );
  } catch (error: any) {
    spinner.fail(`Could not update "${name}"`);
    const msg = error.response?.data?.message ?? error.message ?? String(error);
    console.log(
      chalk.red(`\n  Error: ${Array.isArray(msg) ? msg.join('; ') : msg}\n`),
    );
    command.exit(1);
  }
}
