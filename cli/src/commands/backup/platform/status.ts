import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  BackupClient,
  BackupPolicy,
  BackupPolicyActivity,
  HeartbeatStatus,
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
    const [policies, activities, heartbeat] = await Promise.all([
      client.listPolicies(),
      client.listPolicyActivity(),
      client.heartbeat().catch(() => null),
    ]);
    const platform = policies.filter((p) => p.engineClass === 'platform');
    const activityOf = new Map(activities.map((a) => [a.policyId, a]));

    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            policies: platform.map((p) => ({
              policy: p,
              activity: activityOf.get(p.id) ?? null,
            })),
            heartbeat,
          },
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
    if (heartbeat) this.printHeartbeat(heartbeat);
  }

  private printHeartbeat(h: HeartbeatStatus): void {
    const paint = {
      beating: chalk.green,
      withheld: chalk.red,
      failing: chalk.red,
      off: chalk.dim,
    }[h.state];
    const last = h.lastBeatAt ? chalk.dim(` (last sent ${h.lastBeatAt})`) : '';
    this.log(`   heartbeat now: ${paint(h.state)}${last}`);
    for (const reason of h.reasons) this.log(chalk.yellow(`      ${reason}`));
    this.log('');
  }

  private printPolicy(
    p: BackupPolicy,
    activity: BackupPolicyActivity | null,
  ): void {
    const platform = p.metadata?.platform;
    const recipient = platform?.recipient;
    const heartbeatHost = platform?.heartbeat?.host;

    this.log(
      `   ${chalk.cyan(p.id)}  ${chalk.bold(p.name)}  cluster=${p.clusterId}` +
        (p.enabled === false ? chalk.dim(' [disabled]') : ''),
    );

    const recipientText = recipient
      ? chalk.green(recipient.slice(0, 16) + '…')
      : chalk.red('not configured');
    this.log(`      recipient: ${recipientText}`);

    const heartbeatText = platform?.heartbeat?.set
      ? chalk.green('yes') + ' ' + chalk.dim(`(${heartbeatHost ?? 'set'})`)
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
