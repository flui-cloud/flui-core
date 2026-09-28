import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiError } from '../lib/api-client';
import { CostsClient, costLines } from '../lib/costs-view';

export default class Costs extends Command {
  static readonly description =
    'What your clusters cost: spent and forecast, month by month and provider by provider, deleted clusters included';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --months 12',
    '<%= config.bin %> <%= command.id %> --provider hetzner',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = {
    months: Flags.integer({
      description:
        'Calendar months to show, ending with the current one (1-24)',
      default: 6,
      min: 1,
      max: 24,
    }),
    provider: Flags.string({
      description: 'Only this provider, e.g. hetzner',
    }),
    json: Flags.boolean({
      description: 'Print the answer as JSON',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Costs);
    try {
      const costs = await CostsClient.open().get(flags.months);
      if (flags.json) {
        this.log(JSON.stringify(costs, null, 2));
        return;
      }
      this.log('');
      for (const line of costLines(costs, flags.provider?.toLowerCase())) {
        this.log(line ? `  ${line}` : '');
      }
      this.log('');
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error as string | number | boolean | null | undefined);
      this.log('');
      this.log(chalk.red(`  ${message}`));
      if (error instanceof ApiError && error.statusCode === 404) {
        this.log(
          chalk.dim(
            '  This installation’s API does not serve costs yet: it is running an older build.',
          ),
        );
      }
      this.log('');
      this.exit(1);
    }
  }
}
