import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  AlertDestination,
  DESTINATIONS_PATH,
  alertsApi,
  describeDestination,
} from '../../../lib/alert-destinations';

export default class AlertsDestinationList extends Command {
  static readonly description =
    'Where this installation sends alerts besides the dashboard bell and the administrators’ email';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AlertsDestinationList);
    let destinations: AlertDestination[];
    try {
      destinations =
        await alertsApi().get<AlertDestination[]>(DESTINATIONS_PATH);
    } catch (error: unknown) {
      this.error(
        `Could not read the alert destinations: ${(error as Error).message}`,
      );
    }

    if (flags.output === 'json') {
      this.log(JSON.stringify(destinations, null, 2));
      return;
    }
    if (destinations.length === 0) {
      this.log(
        chalk.dim(
          '\n  No destinations. Add one with `flui alerts destination add`.\n',
        ),
      );
      return;
    }
    this.log('');
    for (const d of destinations) this.log(`  ${describeDestination(d)}`);
    this.log('');
  }
}
