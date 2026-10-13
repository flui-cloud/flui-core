import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt } from '../../lib/prompts';
import { RegistryModeStatus } from '../../lib/registry-mode-view';
import { printRegistryMode } from './status';

export default class RegistryDisable extends Command {
  static readonly description =
    'Send new builds back to GitHub Container Registry and stop the Flui registry, keeping its volume or bucket. Refused while any application runs images from the Flui registry.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --yes',
  ];

  static readonly flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RegistryDisable);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });

    const current = await api.get<RegistryModeStatus>('/registry/mode');
    if (current.mode === 'ghcr') {
      this.log(
        chalk.green('New builds already push to GitHub Container Registry.'),
      );
      return;
    }
    if (!flags.yes) {
      const ok = await confirmPrompt(
        chalk.yellow(
          'Send new builds back to GitHub Container Registry and stop the Flui registry?',
        ),
        false,
      );
      if (!ok) {
        this.log(chalk.green('Cancelled'));
        return;
      }
    }

    const spinner = ora(
      'Switching new builds to GitHub Container Registry…',
    ).start();
    try {
      const status = await api.post<RegistryModeStatus>(
        '/registry/disable',
        {},
      );
      spinner.succeed('New builds now push to GitHub Container Registry.');
      printRegistryMode(status);
    } catch (error) {
      spinner.fail('Nothing changed.');
      this.error((error as Error).message, { exit: 1 });
    }
  }
}
