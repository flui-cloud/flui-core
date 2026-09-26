import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';

export default class AppMaintenanceCancel extends Command {
  static readonly description =
    'Cancel a change held for the maintenance window, before it runs';

  static readonly examples = ['<%= config.bin %> <%= command.id %> shop 3f2a…'];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    id: Args.string({
      description: 'The held change, as `flui app maintenance get` lists it',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppMaintenanceCancel);
    const cluster = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(cluster.id);
    const app = await service.getAppByName(args.name);
    const row = await service.cancelDeferredAction(app.id, args.id);
    this.log(`\n  ${chalk.green('✔')} ${row.outcome ?? 'Cancelled.'}\n`);
  }
}
