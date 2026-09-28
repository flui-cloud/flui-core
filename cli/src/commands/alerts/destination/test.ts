import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import {
  AlertDestinationTestResult,
  DESTINATIONS_PATH,
  alertsApi,
} from '../../../lib/alert-destinations';

export default class AlertsDestinationTest extends Command {
  static readonly description =
    'Send a test alert to one destination and say whether it arrived';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 3f1c0e9a-2b7d-4c55-9a51-0f3d2c6b7e10',
  ];

  static readonly args = {
    id: Args.string({
      description: 'Destination id, from `flui alerts destination list`',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(AlertsDestinationTest);
    let result: AlertDestinationTestResult;
    try {
      result = await alertsApi().post<AlertDestinationTestResult>(
        `${DESTINATIONS_PATH}/${encodeURIComponent(args.id)}/test`,
      );
    } catch (error: unknown) {
      this.error(`Could not send the test: ${(error as Error).message}`);
    }

    if (result.ok) {
      this.log(
        `\n  ${chalk.green('✓')} Delivered (${result.status}). Look for FluiTestAlert at the destination.\n`,
      );
      return;
    }
    const status = result.status ? ` (${result.status})` : '';
    this.log(
      `\n  ${chalk.red('✗')} Not delivered${status}: ${result.error ?? 'no reason given'}\n`,
    );
    this.exit(1);
  }
}
