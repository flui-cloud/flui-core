import { Command } from '@oclif/core';
import chalk from 'chalk';
import { DemoClient } from '../../lib/demo-client';
import { printContextBanner } from '../../lib/context-banner';

export default class DemoEnable extends Command {
  static readonly description =
    'Enable the cross-provider migration demo loop (admin)';

  async run(): Promise<void> {
    printContextBanner();
    await DemoClient.fromConfig().enable();
    this.log(
      chalk.green('\n   demo enabled — the loop will migrate on schedule.\n'),
    );
  }
}
