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

export default class BackupEnableVolumes extends Command {
  static readonly description =
    "Protect an application's volumes on a schedule: their contents copied " +
    'off the cluster. This is the answer for uploads, media and generated ' +
    'files. A volume holding a database is skipped and reported, because a ' +
    'file copy of a running database does not restore.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app --destination <destId>',
    '<%= config.bin %> <%= command.id %> my-app --destination <destId> --schedule "0 3 * * *" --exclude cache',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name, slug or id',
      required: true,
    }),
  };

  static readonly flags = {
    ...SHARED_ENABLE_FLAGS,
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    exclude: Flags.string({
      multiple: true,
      description:
        'Volume name to leave out (repeatable). Everything else is included, ' +
        'including volumes the application grows later.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupEnableVolumes);
    printContextBanner();

    const { id: clusterId } = await resolveClusterRef(flags.cluster);
    const appService = await CliAppService.create(clusterId);
    const app = await appService.getAppByName(args.app);

    const destinations = parseDestinations(flags.destination);
    const client = BackupClient.fromConfig();
    const spinner = ora(
      `Scheduling volume copies for "${app.slug}"...`,
    ).start();
    try {
      const policy = await client.createPolicy({
        name: flags.name ?? `${app.slug}-volumes`,
        clusterId,
        engineClass: 'volume_copy',
        scope: 'applications',
        scopeSelector: { applicationIds: [app.id] },
        cronSchedule: flags.schedule,
        retentionDays: flags['retention-days'],
        retentionMaxCopies: flags['retention-max-copies'],
        enabled: flags.enabled,
        destinations,
        profile: profileFor(destinations),
        ...(flags.exclude?.length
          ? { metadata: { excludeVolumes: flags.exclude } }
          : {}),
      });
      spinner.succeed('Scheduled volume copies enabled');
      const except = flags.exclude?.length
        ? `, except ${flags.exclude.join(', ')}`
        : '';
      printEnabled(
        policy,
        `${app.slug} — every volume${except}`,
        flags.schedule ?? 'on the default schedule',
      );
      console.log(
        chalk.dim(
          '   Volumes are decided one by one on every run, so a volume added later is\n' +
            '   picked up. One holding a database is skipped and named in the run —\n' +
            '   for those use `flui backup enable database`, or stop the app and copy it.\n',
        ),
      );
    } catch (error: any) {
      spinner.fail('Could not schedule volume copies');
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
