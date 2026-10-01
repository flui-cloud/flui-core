import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  BackupClient,
  BackupPolicy,
  BackupPolicyActivity,
} from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';
import {
  healthLine,
  runLines,
  scheduleText,
  utcMoment,
} from '../../../lib/backup-activity-format';

export default class BackupPlatformStatus extends Command {
  static readonly description =
    "Show the master-resilience (platform) backup policies: operator recipient, dead-man's switch, schedule, next run, health and the last run.";

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupPlatformStatus);
    if (!flags.json) printContextBanner();

    const client = BackupClient.fromConfig();
    const [policies, activities] = await Promise.all([
      client.listPolicies(),
      client.listPolicyActivity(),
    ]);
    const platform = policies.filter((p) => p.engineClass === 'platform');
    const activityOf = new Map(activities.map((a) => [a.policyId, a]));

    if (flags.json) {
      this.log(
        JSON.stringify(
          platform.map((p) => ({
            policy: p,
            activity: activityOf.get(p.id) ?? null,
          })),
          null,
          2,
        ),
      );
      return;
    }

    if (platform.length === 0) {
      this.log(chalk.yellow('\n   No platform backup policies.\n'));
      return;
    }

    this.log('');
    for (const p of platform) {
      this.printPolicy(p, activityOf.get(p.id) ?? null);
    }
  }

  private printPolicy(
    p: BackupPolicy,
    activity: BackupPolicyActivity | null,
  ): void {
    const platform = p.metadata?.platform;
    const recipient = platform?.recipient;
    const heartbeatUrl = platform?.heartbeat?.url;

    this.log(
      `   ${chalk.cyan(p.id)}  ${chalk.bold(p.name)}  cluster=${p.clusterId}` +
        (p.enabled === false ? chalk.dim(' [disabled]') : ''),
    );

    const recipientText = recipient
      ? chalk.green(recipient.slice(0, 16) + '…')
      : chalk.red('not configured');
    this.log(`      recipient: ${recipientText}`);

    const heartbeatText = heartbeatUrl
      ? chalk.green('yes') + ' ' + chalk.dim('(' + heartbeatUrl + ')')
      : chalk.yellow('no');
    this.log(`      heartbeat: ${heartbeatText}`);

    if (!activity) {
      this.log(`      health:    ${chalk.dim('unknown')}`);
      this.log('');
      return;
    }
    this.log(`      schedule:  ${scheduleText(activity)}`);
    this.log(`      next run:  ${utcMoment(activity.schedule.nextRunAt)}`);
    this.log(`      health:    ${healthLine(activity)}`);
    this.log(`      last good: ${utcMoment(activity.health.lastSuccessAt)}`);
    this.log('      last run:');
    const shown = activity.lastRun ? [activity.lastRun] : [];
    for (const line of runLines(shown)) {
      this.log(`        ${line.replaceAll('\n', '\n        ')}`);
    }
    this.log('');
  }
}
