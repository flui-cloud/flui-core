import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import {
  SHARED_ENABLE_FLAGS,
  parseDestinations,
  printEnabled,
  profileFor,
} from '../../../lib/backup-enable';

export default class BackupEnablePlatform extends Command {
  static readonly description =
    'Protect Flui itself: the control-plane database, sealed so only the ' +
    'recipient holding the passphrase can open it. This is what a rebuild ' +
    'starts from when the cluster running Flui is gone.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --destination <destId> --recipient <age-recipient>',
  ];

  static readonly flags = {
    ...SHARED_ENABLE_FLAGS,
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    recipient: Flags.string({
      required: true,
      description:
        'age recipient the dump is sealed to. Without the matching identity ' +
        'nobody — including Flui — can open the backup.',
    }),
    'heartbeat-url': Flags.string({
      description: 'Pinged after each successful run, so silence is detectable',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupEnablePlatform);
    printContextBanner();

    const { id: clusterId } = await resolveClusterRef(flags.cluster);
    const client = BackupClient.fromConfig();
    const destinations = parseDestinations(flags.destination);
    const spinner = ora('Enabling platform backup...').start();
    try {
      const policy = await client.createPolicy({
        name: flags.name ?? 'flui-control-plane',
        clusterId,
        engineClass: 'platform',
        // The platform dump is the control-plane database itself; there is
        // nothing in the cluster for a scope to narrow.
        scope: 'cluster_all',
        cronSchedule: flags.schedule,
        retentionDays: flags['retention-days'],
        retentionMaxCopies: flags['retention-max-copies'],
        enabled: flags.enabled,
        destinations,
        profile: profileFor(destinations),
      });
      // Sealing is configured after the policy exists, so a policy that failed
      // to be created never leaves a recipient recorded against nothing.
      await client.setPlatformConfig(policy.id, {
        recipient: flags.recipient,
        heartbeatUrl: flags['heartbeat-url'],
      });
      spinner.succeed('Platform backup enabled');
      printEnabled(
        policy,
        'the Flui control-plane database',
        flags.schedule ?? 'on the default schedule',
      );
      console.log(
        chalk.yellow(
          '   Keep the age identity somewhere this cluster is not. Without it the\n' +
            '   backup cannot be opened, and a rebuild has nothing to start from.',
        ),
      );
      console.log(
        chalk.dim(
          '\n   flui backup platform restore    open a sealed bundle\n',
        ),
      );
    } catch (error: any) {
      spinner.fail('Could not enable platform backup');
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
