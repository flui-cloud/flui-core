import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { DESTINATIONS_PATH, alertsApi } from '../../../lib/alert-destinations';

export default class AlertsDestinationRemove extends Command {
  static readonly description = 'Stop sending alerts to a destination';

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
    const { args } = await this.parse(AlertsDestinationRemove);
    try {
      await alertsApi().delete(
        `${DESTINATIONS_PATH}/${encodeURIComponent(args.id)}`,
      );
    } catch (error: unknown) {
      this.error(
        `Could not remove the destination: ${(error as Error).message}`,
      );
    }
    this.log(`\n  ${chalk.green('✓')} Alerts are no longer sent there.\n`);
  }
}
