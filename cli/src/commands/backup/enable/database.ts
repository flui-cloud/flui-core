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
  recordedSchedule,
} from '../../../lib/backup-enable';

export default class BackupEnableDatabase extends Command {
  static readonly description =
    'Protect a database with continuous backup: every change is ' +
    'shipped off-cluster as it happens, so it can be restored to any moment ' +
    'in the retained window rather than to the last nightly copy. Base ' +
    'backups run daily at 02:30 UTC unless --schedule says otherwise. A database ' +
    'whose image cannot do that — the ones inside catalog bundles — gets ' +
    'scheduled dumps instead (daily at 03:00 UTC unless --schedule says otherwise).';

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
      // The engine the server recorded, not a guess in the client: writing
      // "Postgres" on a MariaDB was a false line in the one message that
      // confirms what has just been protected.
      const engine = (policy as { engine?: string }).engine;
      const dumps = engine?.endsWith('-dump') ?? false;
      spinner.succeed(
        dumps
          ? 'Scheduled dumps enabled — this image cannot back up continuously'
          : 'Continuous backup enabled',
      );
      const schedule = await recordedSchedule(client, policy);
      printEnabled(
        policy,
        engine ? `${app.slug} (${engine})` : app.slug,
        dumps ? schedule : `continuously, base backups: ${schedule}`,
      );
      console.log(
        chalk.dim(
          dumps
            ? '   The first dump is running now. Each dump restores the moment it was\n' +
                '   taken, into a new database; changes after the last one are not kept.\n'
            : '   The first base backup is running now — until it finishes there is\n' +
                '   nothing for the shipped changes to be replayed onto.\n',
        ),
      );
      console.log(
        chalk.dim(
          `   flui backup status --app ${app.slug}   what is recoverable\n`,
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
