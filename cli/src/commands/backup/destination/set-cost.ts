import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupDestinationSetCost extends Command {
  static readonly description =
    'Set what a backup destination costs, in euro cents per GB per month, so ' +
    'backup cost estimates use your price. --list-price goes back to the ' +
    'published price Flui knows for the provider.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> a83dad2e-… 1.606',
    '<%= config.bin %> <%= command.id %> a83dad2e-… --list-price',
  ];

  static readonly args = {
    id: Args.string({ required: true, description: 'Destination ID' }),
    cents: Args.string({
      required: false,
      description: 'Euro cents per GB per month, e.g. 1.606',
    }),
  };

  static readonly flags = {
    'list-price': Flags.boolean({
      description: 'Use the published list price for the provider',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupDestinationSetCost);
    if (flags['list-price'] === (args.cents !== undefined)) {
      this.error(
        'Give a price in cents per GB per month, or --list-price (not both).',
      );
    }
    const cents = flags['list-price'] ? null : Number(args.cents);
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) {
      this.error(
        `"${args.cents}" is not a price: use cents per GB per month, e.g. 1.606`,
      );
    }
    printContextBanner();
    const spinner = ora(`Updating destination ${args.id}...`).start();
    try {
      const dest = await BackupClient.fromConfig().setDestinationCost(
        args.id,
        cents,
      );
      const set = dest.costPerGbMonthCents;
      const source =
        dest.metadata?.costSource === 'list-price'
          ? chalk.dim(' (published list price)')
          : '';
      spinner.succeed(
        set == null
          ? 'No price known for this provider: set one to get estimates'
          : `Priced at ${set} cents per GB per month` + source,
      );
    } catch (err: any) {
      spinner.fail('Not changed');
      this.log(
        chalk.red(
          `\n  ${err?.response?.data?.message ?? err?.message ?? String(err)}\n`,
        ),
      );
      this.exit(1);
    }
  }
}
