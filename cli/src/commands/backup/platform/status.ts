import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  BackupClient,
  BackupJob,
  BackupPolicy,
} from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

const FRESH_WINDOW_MS = 45 * 60 * 1000;

export default class BackupPlatformStatus extends Command {
  static readonly description =
    "Show the master-resilience (platform) backup policies: operator recipient, dead-man's switch, schedule and freshness of the last run.";

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupPlatformStatus);
    if (!flags.json) printContextBanner();

    const client = BackupClient.fromConfig();
    const policies = (await client.listPolicies()).filter(
      (p) => p.engineClass === 'platform',
    );

    // Jobs are only listable per cluster; cache so multiple policies on one
    // cluster share a single fetch.
    const jobsByCluster = new Map<string, BackupJob[]>();
    const lastJobFor = async (p: BackupPolicy): Promise<BackupJob | null> => {
      if (!jobsByCluster.has(p.clusterId)) {
        jobsByCluster.set(
          p.clusterId,
          await client.listJobsForCluster(p.clusterId),
        );
      }
      // findByCluster returns createdAt DESC, so the first match is the latest.
      return (
        jobsByCluster.get(p.clusterId)?.find((j) => j.policyId === p.id) ?? null
      );
    };

    if (flags.json) {
      const data = [];
      for (const p of policies) {
        data.push({ policy: p, lastJob: await lastJobFor(p) });
      }
      this.log(JSON.stringify(data, null, 2));
      return;
    }

    if (policies.length === 0) {
      this.log(chalk.yellow('\n   No platform backup policies.\n'));
      return;
    }

    this.log('');
    for (const p of policies) {
      const job = await lastJobFor(p);
      this.printPolicy(p, job);
    }
  }

  private printPolicy(p: BackupPolicy, job: BackupJob | null): void {
    const platform = p.metadata?.platform;
    const recipient = platform?.recipient;
    const heartbeatUrl = platform?.heartbeat?.url;

    this.log(
      `   ${chalk.cyan(p.id)}  ${chalk.bold(p.name)}  cluster=${p.clusterId}` +
        (p.enabled === false ? chalk.dim(' [disabled]') : ''),
    );

    this.log(
      `      recipient: ${
        recipient
          ? chalk.green(`${recipient.slice(0, 16)}…`)
          : chalk.red('not configured')
      }`,
    );

    this.log(
      `      heartbeat: ${
        heartbeatUrl
          ? `${chalk.green('yes')} ${chalk.dim(`(${heartbeatUrl})`)}`
          : chalk.yellow('no')
      }`,
    );

    this.log(
      `      schedule:  ${p.cronSchedule ? chalk.white(p.cronSchedule) : chalk.dim('none')}`,
    );

    this.log(`      last run:  ${this.formatLastRun(job)}`);
    this.log('');
  }

  private formatLastRun(job: BackupJob | null): string {
    if (!job) return chalk.dim('no runs yet');

    const status =
      job.status === 'completed'
        ? chalk.green(job.status)
        : job.status === 'failed'
          ? chalk.red(job.status)
          : chalk.yellow(job.status);

    const when = job.finishedAt ? chalk.dim(job.finishedAt) : '';

    const fresh =
      job.status === 'completed' &&
      job.finishedAt &&
      Date.now() - Date.parse(job.finishedAt) <= FRESH_WINDOW_MS;

    const freshness = fresh
      ? chalk.green('fresh')
      : chalk.yellow("stale — dead-man's switch will alarm");

    return `${status} ${when}  ${freshness}`.trim();
  }
}
