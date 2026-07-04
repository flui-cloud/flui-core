import { Command } from '@oclif/core';
import chalk from 'chalk';
import { DemoClient } from '../../lib/demo-client';
import { printContextBanner } from '../../lib/context-banner';

export default class DemoDisable extends Command {
  static readonly description =
    'Disable the cross-provider migration demo loop; an in-flight cycle finishes (admin)';

  async run(): Promise<void> {
    printContextBanner();
    await DemoClient.fromConfig().disable();
    this.log(chalk.yellow('\n   demo disabled — no new cycles will start.\n'));
  }
}
