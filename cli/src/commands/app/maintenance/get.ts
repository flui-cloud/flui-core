import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { printDeferred, printOpening } from '../../../lib/maintenance-view';

export default class AppMaintenanceGet extends Command {
  static readonly description =
    'Which maintenance window governs an application, when it next opens, and the changes held for it';

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
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppMaintenanceGet);
    const cluster = await resolveClusterRef(flags.cluster);
    const service = await CliAppService.create(cluster.id);
    const app = await service.getAppByName(args.name);
    const [reading, held] = await Promise.all([
      service.appMaintenance(app.id),
      service.appDeferredActions(app.id),
    ]);
    if (flags.json) {
      this.log(JSON.stringify({ ...reading, deferred: held }, null, 2));
      return;
    }
    this.log(`\n  ${chalk.bold(args.name)}  ${reading.says}`);
    printOpening(reading.nextOpening);
    printDeferred(held);
    this.log('');
  }
}
