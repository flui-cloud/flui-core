import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { windowOf } from '../../../lib/maintenance-slot';
import { printOpening } from '../../../lib/maintenance-view';

export default class EnvMaintenanceSet extends Command {
  static readonly description =
    'Set a cluster\'s maintenance window: weekly slots in one time zone. Changes held "for the next window" run when it opens; applications follow it unless they set their own.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --slot "tue,thu 02:00 2h" --timezone Europe/Rome',
    '<%= config.bin %> <%= command.id %> --slot "sat 03:00 90m" --slot "sun 03:00 90m"',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    slot: Flags.string({
      description:
        'Days, start and length, e.g. "tue,thu 02:00 2h"; repeat for more slots',
      multiple: true,
      required: true,
    }),
    timezone: Flags.string({
      description: 'IANA time zone the slots are read in',
      default: 'UTC',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvMaintenanceSet);
    let window;
    try {
      window = windowOf(flags.slot, flags.timezone);
    } catch (err) {
      this.error((err as Error).message);
    }
    const cluster = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(cluster.id);
    const written = await service.setClusterMaintenance(cluster.id, window);
    this.log(`\n  ${chalk.green('✔')} ${cluster.name}: ${written.says}`);
    printOpening(written.nextOpening);
    this.log('');
  }
}
