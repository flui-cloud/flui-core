import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient, BackupPolicyActivity } from '../../../lib/backup-client';
import {
  healthLine,
  runLines,
  scheduleText,
  utcMoment,
} from '../../../lib/backup-activity-format';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupPolicyShow extends Command {
  static readonly description =
    'Show a backup policy by ID: its schedule in words, the next run, its health and the last five runs';
  static readonly args = {
    id: Args.string({ required: true, description: 'Policy ID' }),
  };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupPolicyShow);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const [p, activity] = await Promise.all([
      client.getPolicy(args.id),
      client.getPolicyActivity(args.id, 5),
    ]);
    if (flags.json) {
      this.log(JSON.stringify({ ...p, activity }, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold('ID:')}        ${p.id}`);
    this.log(`   ${chalk.bold('Name:')}      ${p.name}`);
    this.log(
      `   ${chalk.bold('Cluster:')}   ${clusterLine(p.clusterId, activity)}`,
    );
    this.log(`   ${chalk.bold('Engine:')}    ${p.engineClass ?? '—'}`);
    this.log(`   ${chalk.bold('Profile:')}   ${p.profile}`);
    this.log(`   ${chalk.bold('Scope:')}     ${p.scope}`);
    for (const [i, app] of (activity.targets?.applications ?? []).entries()) {
      this.log(
        `   ${chalk.bold(i === 0 ? 'Apps:' : '     ')}      ${appLine(app)}`,
      );
    }
    this.log(`   ${chalk.bold('Schedule:')}  ${scheduleText(activity)}`);
    this.log(
      `   ${chalk.bold('Next run:')}  ${utcMoment(activity.schedule.nextRunAt)}`,
    );
    this.log(`   ${chalk.bold('Health:')}    ${healthLine(activity)}`);
    this.log(
      `   ${chalk.bold('Last good:')} ${utcMoment(activity.health.lastSuccessAt)}`,
    );
    if (typeof p.retentionDays === 'number')
      this.log(`   ${chalk.bold('Retention:')} ${p.retentionDays} days`);
    if (p.destinations?.length) {
      this.log(`   ${chalk.bold('Destinations:')}`);
      for (const d of p.destinations) {
        const prio = d.priority == null ? '' : ` prio=${d.priority}`;
        this.log(`     - ${d.destinationId} (${d.role}${prio})`);
      }
    }
    this.log(`   ${chalk.bold('Recent runs:')}`);
    for (const line of runLines(activity.runs)) {
      this.log(`     ${line.replaceAll('\n', '\n     ')}`);
    }
    this.log('');
  }
}

type Targets = NonNullable<BackupPolicyActivity['targets']>;

function clusterLine(
  clusterId: string,
  activity: BackupPolicyActivity,
): string {
  const c = activity.targets?.cluster;
  if (!c?.name) return clusterId;
  return c.gone ? `${c.name} ${chalk.dim('(deleted)')}` : c.name;
}

function appLine(app: Targets['applications'][number]): string {
  if (!app.name) return `${app.id} ${chalk.dim('(deleted)')}`;
  const slug =
    app.slug && app.slug !== app.name ? ` ${chalk.dim(app.slug)}` : '';
  const gone =
    app.goneWith === 'cluster' ? ' (deleted with its cluster)' : ' (deleted)';
  return `${app.name}${slug}${app.gone ? chalk.dim(gone) : ''}`;
}
