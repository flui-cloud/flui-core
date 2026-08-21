import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ShowcaseClient } from '../../lib/showcase-client';
import { printContextBanner } from '../../lib/context-banner';

/**
 * Publishing is explicit, one application at a time, with a line that says what
 * the thing actually is. Nothing lands in the showcase by inference — that is
 * the property that lets a visitor believe what it says.
 */
export default class ShowcaseAdd extends Command {
  static readonly description = 'Publish one application to the showcase';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> umami-29491d --note "Measures flui.cloud. Real visitors."',
  ];
  static readonly args = {
    app: Args.string({
      description: 'Application slug, name or id',
      required: true,
    }),
  };
  static readonly flags = {
    note: Flags.string({
      description:
        "The line shown next to it, stored as the application's description",
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ShowcaseAdd);
    printContextBanner();

    const item = await ShowcaseClient.fromConfig().publish(
      args.app,
      flags.note,
    );
    if (flags.json) {
      this.log(JSON.stringify(item, null, 2));
      return;
    }

    this.log('');
    this.log(`   ${chalk.green('in the showcase')}  ${chalk.bold(item.name)}`);
    if (item.note) this.log(`   says  ${item.note}`);
    if (item.url) this.log(`   at    ${chalk.cyan(item.url)}`);
    this.log('');
  }
}
