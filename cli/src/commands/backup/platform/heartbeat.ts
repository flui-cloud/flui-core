import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupPlatformHeartbeat extends Command {
  static readonly description =
    'Set or remove the heartbeat address of the platform backup. Every 5 minutes, while the database, the metrics and the alert delivery work and the last platform backup is fresh, the installation calls it; your watchdog (for example healthchecks.io) raises the alarm when the calls stop. Keep the address private: anyone who has it can send calls in your name.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> https://hc-ping.com/<uuid>',
    '<%= config.bin %> <%= command.id %> --clear',
  ];

  static readonly args = {
    url: Args.string({ description: 'Address to call', required: false }),
  };

  static readonly flags = {
    clear: Flags.boolean({
      description: 'Stop the heartbeat and forget the address',
      exclusive: ['url'],
    }),
    policy: Flags.string({
      char: 'p',
      description: 'Platform backup policy ID, when there is more than one',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupPlatformHeartbeat);
    if (!args.url && !flags.clear) {
      this.error('Give the address to call, or --clear to stop the heartbeat.');
    }
    printContextBanner();

    const client = BackupClient.fromConfig();
    const platform = (await client.listPolicies()).filter(
      (p) =>
        p.engineClass === 'platform' &&
        (!flags.policy || p.id === flags.policy),
    );
    if (platform.length === 0) {
      this.error(
        flags.policy
          ? `No platform backup policy ${flags.policy}.`
          : 'No platform backup yet. Enable one first: flui backup enable platform -D <destination>',
      );
    }
    if (platform.length > 1) {
      this.error(
        `More than one platform backup policy. Choose one with --policy: ${platform.map((p) => p.id).join(', ')}`,
      );
    }
    const policy = platform[0];
    const recipient = policy.metadata?.platform?.recipient;
    if (!recipient) {
      this.error(
        'This platform backup has no recipient yet. Run: flui backup platform init',
      );
    }

    await client.setPlatformConfig(policy.id, {
      recipient,
      heartbeatUrl: args.url,
      clearHeartbeat: flags.clear,
    });
    this.log(
      flags.clear
        ? `\n   Heartbeat stopped for ${chalk.bold(policy.name)}.\n`
        : `\n   Heartbeat set for ${chalk.bold(policy.name)}. Check it with: flui backup platform status\n`,
    );
  }
}
