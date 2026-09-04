import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';
import {
  SHARED_ENABLE_FLAGS,
  parseDestinations,
  printEnabled,
  profileFor,
} from '../../../lib/backup-enable';

export default class BackupEnableDatabase extends Command {
  static readonly description =
    'Protect a Postgres database with continuous backup: every change is ' +
    'shipped off-cluster as it happens, so it can be restored to any moment ' +
    'in the retained window rather than to the last nightly copy.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-database --destination <destId>',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Database application name, slug or id',
      required: true,
    }),
  };

  static readonly flags = {
    ...SHARED_ENABLE_FLAGS,
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupEnableDatabase);
    printContextBanner();

    const { id: clusterId } = await resolveClusterRef(flags.cluster);
    const appService = await CliAppService.create(clusterId);
    const app = await appService.getAppByName(args.app);

    const destinations = parseDestinations(flags.destination);
    const client = BackupClient.fromConfig();
    const spinner = ora(
      `Setting up continuous backup for "${app.slug}"...`,
    ).start();
    try {
      const policy = await client.enableDatabase({
        name: flags.name ?? `${app.slug}-continuous`,
        clusterId,
        engineClass: 'database',
        scope: 'applications',
        scopeSelector: { applicationIds: [app.id] },
        cronSchedule: flags.schedule,
        retentionDays: flags['retention-days'],
        retentionMaxCopies: flags['retention-max-copies'],
        enabled: flags.enabled,
        destinations,
        profile: profileFor(destinations),
      });
      spinner.succeed('Continuous backup enabled');
      printEnabled(policy, `${app.slug} (Postgres)`, 'continuously');
      console.log(
        chalk.dim(
          '   The first base backup is running now — until it finishes there is\n' +
            '   nothing for the shipped changes to be replayed onto.\n',
        ),
      );
      console.log(
        chalk.dim(
          `   flui backup status --app ${app.slug}   the recoverable window\n`,
        ),
      );
    } catch (error: any) {
      spinner.fail('Could not enable continuous backup');
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
