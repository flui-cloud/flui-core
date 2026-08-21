import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ShowcaseClient } from '../../lib/showcase-client';
import { printContextBanner } from '../../lib/context-banner';

export default class ShowcaseRemove extends Command {
  static readonly description =
    'Take one application out of the showcase (it keeps running)';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> umami-29491d',
  ];
  static readonly args = {
    app: Args.string({
      description: 'Application slug, name or id',
      required: true,
    }),
  };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args } = await this.parse(ShowcaseRemove);
    printContextBanner();

    await ShowcaseClient.fromConfig().withdraw(args.app);
    this.log(
      chalk.dim(
        `\n   ${args.app} is no longer in the showcase. It keeps running.\n`,
      ),
    );
  }
}
