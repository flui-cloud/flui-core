import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import { ProfileManager } from '../../../lib/profile-manager';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { SealedPlatformIdentity } from '../../../lib/vault/sealed-platform-identity';
import {
  SHARED_ENABLE_FLAGS,
  parseDestinations,
  printEnabled,
  profileFor,
  recordedSchedule,
} from '../../../lib/backup-enable';

export default class BackupEnablePlatform extends Command {
  static readonly description =
    'Protect Flui itself: the control-plane database, sealed so only the ' +
    'recipient holding the passphrase can open it. This is what a rebuild ' +
    'starts from when the cluster running Flui is gone.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --destination <destId>',
    '<%= config.bin %> <%= command.id %> --destination <destId> --recipient <age-recipient>',
  ];

  static readonly flags = {
    ...SHARED_ENABLE_FLAGS,
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    recipient: Flags.string({
      description:
        'age recipient the dump is sealed to. Without the matching identity ' +
        'nobody — including Flui — can open the backup. Defaults to the key ' +
        'kept in your vault by `flui backup platform init`.',
    }),
    'heartbeat-url': Flags.string({
      description:
        'Called every 5 minutes while the installation is healthy and its last platform backup is fresh; your watchdog raises the alarm when the calls stop. Change it later with `flui backup platform heartbeat`.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupEnablePlatform);
    printContextBanner();

    const recipient =
      flags.recipient ??
      new SealedPlatformIdentity(ProfileManager.getActiveProfile()).recipient();
    if (!recipient) {
      this.error(
        'No platform backup key yet. Create one in your vault first:\n' +
          '  flui backup platform init',
        { exit: 1 },
      );
    }

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
        recipient,
        heartbeatUrl: flags['heartbeat-url'],
      });
      spinner.succeed('Platform backup enabled');
      printEnabled(
        policy,
        'the Flui control-plane database',
        await recordedSchedule(client, policy),
      );
      console.log(
        chalk.yellow(
          '   Keep the recovery copy from `flui backup platform init` somewhere this\n' +
            '   cluster and this machine are not. It opens with your vault passphrase;\n' +
            '   without it a rebuild has nothing to start from.',
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
