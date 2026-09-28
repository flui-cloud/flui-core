import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ADMIN_ROUTING_PATH, alertsApi } from '../../lib/alert-destinations';

export default class AlertsWarnings extends Command {
  static readonly description =
    'Whether administrators are emailed warnings about nodes, disks and certificates, not only critical alerts';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --on',
    '<%= config.bin %> <%= command.id %> --off',
  ];

  static readonly flags = {
    on: Flags.boolean({
      description: 'Email administrators warnings too',
      exclusive: ['off'],
    }),
    off: Flags.boolean({
      description: 'Email administrators critical alerts only (the default)',
      exclusive: ['on'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AlertsWarnings);
    const api = alertsApi();
    let state: { warnings: boolean };
    try {
      state =
        flags.on || flags.off
          ? await api.put<{ warnings: boolean }>(ADMIN_ROUTING_PATH, {
              warnings: Boolean(flags.on),
            })
          : await api.get<{ warnings: boolean }>(ADMIN_ROUTING_PATH);
    } catch (error: unknown) {
      this.error(
        `Could not read or change the setting: ${(error as Error).message}`,
      );
    }

    this.log(
      state.warnings
        ? `\n  ${chalk.yellow('on')}   Administrators are emailed warnings and critical alerts about what no application owns.\n`
        : `\n  ${chalk.green('off')}  Administrators are emailed critical alerts only.\n`,
    );
  }
}
