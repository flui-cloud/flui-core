import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { windowOf } from '../../../lib/maintenance-slot';
import { printOpening } from '../../../lib/maintenance-view';

export default class AppMaintenanceSet extends Command {
  static readonly description =
    "Let an application follow its cluster's maintenance window (the default), keep one of its own, or take such changes at any time";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> shop --follow',
    '<%= config.bin %> <%= command.id %> shop --slot "sun 04:00 1h" --timezone Europe/Rome',
    '<%= config.bin %> <%= command.id %> shop --anytime',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    follow: Flags.boolean({
      description: "Follow the cluster's window",
      exclusive: ['anytime', 'slot'],
    }),
    anytime: Flags.boolean({
      description: 'Take such changes at any time',
      exclusive: ['follow', 'slot'],
    }),
    slot: Flags.string({
      description:
        'A window of its own: days, start and length, e.g. "sun 04:00 1h"; repeat for more',
      multiple: true,
    }),
    timezone: Flags.string({
      description: 'Time zone for --slot',
      default: 'UTC',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppMaintenanceSet);
    if (!flags.follow && !flags.anytime && !flags.slot?.length) {
      this.error('Pass --follow, --anytime or at least one --slot.');
    }
    let body: {
      mode: 'follow' | 'own' | 'anytime';
      window?: ReturnType<typeof windowOf>;
    };
    try {
      body = flags.slot?.length
        ? { mode: 'own', window: windowOf(flags.slot, flags.timezone) }
        : { mode: flags.anytime ? 'anytime' : 'follow' };
    } catch (err) {
      this.error((err as Error).message);
    }
    const cluster = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(cluster.id);
    const app = await service.getAppByName(args.name);
    const written = await service.setAppMaintenance(app.id, body);
    this.log(`\n  ${chalk.green('✔')} ${args.name}: ${written.says}`);
    printOpening(written.nextOpening);
    this.log('');
  }
}
