import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SandboxClient } from '../../lib/sandbox-client';
import { printContextBanner } from '../../lib/context-banner';
import { visitorLines } from '../../lib/visitor-stats-format';

export default class SandboxVisitors extends Command {
  static readonly description =
    'What the demo’s visitors’ entrance is doing: visitors now, ready ahead of time, the last day, and who became an account';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SandboxVisitors);
    const stats = await SandboxClient.fromConfig().visitorStats();
    if (flags.json) {
      this.log(JSON.stringify(stats, null, 2));
      return;
    }
    printContextBanner();
    this.log('');
    this.log(`   ${chalk.bold('Visitors')}`);
    for (const line of visitorLines(stats)) this.log(line);
    this.log('');
  }
}
