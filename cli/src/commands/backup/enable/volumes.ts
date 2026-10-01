import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient, BackupPolicy } from '../../../lib/backup-client';
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
    pause: Flags.boolean({
      description:
        'Stop the application for the length of each copy, so every volume is ' +
        'copied at rest. Each run records how long it was stopped.',
      default: false,
    }),
    exclude: Flags.string({
      multiple: true,
      description:
        'Volume name to leave out (repeatable). Everything else is included, ' +
        'including volumes the application grows later.',
    }),
    'keep-monthly': Flags.boolean({
      description:
        'Also keep 3 monthly backups on top of 7 daily and 4 weekly ' +
        '(about 30% more space for two more months of history).',
      allowNo: true,
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
    const existing = (await client.listPoliciesForCluster(clusterId)).find(
      (p) =>
        p.engineClass === 'volume_copy' &&
        (p.scopeSelector?.applicationIds ?? []).includes(app.id),
    );
    if (existing) {
      await this.updateExisting(client, existing, app.slug, flags);
      return;
    }
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
        ...(flags.exclude?.length || flags.pause || flags['keep-monthly']
          ? {
              metadata: {
                ...(flags.exclude?.length
                  ? { excludeVolumes: flags.exclude }
                  : {}),
                ...(flags.pause ? { pauseDuringCopy: true } : {}),
                ...(flags['keep-monthly'] ? { keepMonthly: true } : {}),
              },
            }
          : {}),
      });
      spinner.succeed('Scheduled volume copies enabled');
      const except = flags.exclude?.length
        ? `, except ${flags.exclude.join(', ')}`
        : '';
      printEnabled(
        policy,
        `${app.slug} — every volume${except}`,
        await recordedSchedule(client, policy),
      );
      console.log(
        chalk.dim(
          '   Volumes are decided one by one on every run, so a volume added later is\n' +
            "   picked up. SQLite files are copied with SQLite's own online backup; any\n" +
            '   other database is skipped and named in the run — for those use\n' +
            '   `flui backup enable database`, or --pause to copy with the app stopped.\n',
        ),
      );
    } catch (error: any) {
      spinner.fail('Could not schedule volume copies');
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }

  /**
   * One volume-copy policy per application: asking again changes the one that
   * exists — which is how a volume that needs a decision gets one — instead of
   * adding a second policy copying the same volumes.
   */
  private async updateExisting(
    client: BackupClient,
    policy: BackupPolicy,
    slug: string,
    flags: { pause: boolean; exclude?: string[]; 'keep-monthly'?: boolean },
  ): Promise<void> {
    const monthly = flags['keep-monthly'];
    if (!flags.pause && !flags.exclude?.length && monthly === undefined) {
      console.log(
        chalk.dim(
          `\n  ${slug} already has scheduled volume copies (policy ${policy.id}). ` +
            'Pass --pause, --exclude or --[no-]keep-monthly to change them.\n',
        ),
      );
      return;
    }
    const current = Array.isArray(policy.metadata?.excludeVolumes)
      ? (policy.metadata.excludeVolumes as string[])
      : [];
    const spinner = ora(`Updating the volume copies of "${slug}"...`).start();
    try {
      await client.updatePolicyOptions(policy.id, {
        ...(flags.pause ? { pauseDuringCopy: true } : {}),
        ...(flags.exclude?.length
          ? { excludeVolumes: [...new Set([...current, ...flags.exclude])] }
          : {}),
        ...(monthly === undefined ? {} : { keepMonthly: monthly }),
      });
      spinner.succeed('Volume copies updated');
      if (flags.pause) {
        console.log(
          chalk.dim(
            '   The application is stopped for the length of each copy from the next run.',
          ),
        );
      }
      if (flags.exclude?.length) {
        console.log(chalk.dim(`   Left out: ${flags.exclude.join(', ')}`));
      }
      if (monthly !== undefined) {
        console.log(
          chalk.dim(
            monthly
              ? '   Keeps 3 monthly backups as well, from the next run.'
              : '   Keeps 7 daily and 4 weekly backups, no monthly ones, from the next run.',
          ),
        );
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Could not update the volume copies');
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
