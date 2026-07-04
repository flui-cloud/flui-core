import { Command } from '@oclif/core';
import chalk from 'chalk';
import { DemoClient } from '../../lib/demo-client';
import { printContextBanner } from '../../lib/context-banner';

export default class DemoTrigger extends Command {
  static readonly description =
    'Trigger one migration cycle now, ignoring the interval timer (admin)';

  async run(): Promise<void> {
    printContextBanner();
    await DemoClient.fromConfig().trigger();
    this.log(chalk.green('\n   migration cycle triggered.\n'));
  }
}
