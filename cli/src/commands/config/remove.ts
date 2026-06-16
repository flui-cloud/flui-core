import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmByTypingPrompt } from '../../lib/prompts';
import { classifyKey, formatKnownKeys } from '../../config/key-router';
import { PreferenceKey } from '../../config/preferences-schema';

export default class ConfigRemove extends Command {
  static readonly description =
    'Remove a stored preference or an encrypted provider token. Dispatch is schema-driven by key name.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner',
    '<%= config.bin %> <%= command.id %> email',
    '<%= config.bin %> <%= command.id %> scaleway --force',
    '<%= config.bin %> <%= command.id %> api-url',
  ];

  static readonly args = {
    key: Args.string({
      required: true,
      description:
        'Configuration key: a preference, a provider name, or a system override (api-url)',
    }),
  };

  static readonly flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConfigRemove);

    try {
      const storage = new ConfigStorage();
      const kind = classifyKey(args.key);

      if (kind === 'unknown') {
        console.log(chalk.red(`\nUnknown configuration key: '${args.key}'\n`));
        console.log(formatKnownKeys());
        console.log();
        this.exit(1);
      }

      if (kind === 'system') {
        if (args.key.toLowerCase() === 'api-url') {
          storage.removeApiUrl();
          console.log(chalk.green(`\nAPI URL removed`));
          console.log(chalk.gray(`Location: ${storage.getConfigPath()}\n`));
        }
        return;
      }

      if (kind === 'preference') {
        const key = args.key as PreferenceKey;
        if (storage.getPreference(key) === null) {
          console.log(chalk.yellow(`\nPreference '${key}' is not set\n`));
          return;
        }
        storage.removePreference(key);
        console.log(chalk.green(`\nRemoved preference: ${key}`));
        console.log(chalk.gray(`Location: ${storage.getConfigPath()}\n`));
        return;
      }

      // provider
      const provider = args.key.toLowerCase();
      const hasToken = storage.hasToken(provider);
      const hasCreds = storage.hasCredentials(provider);
      if (!hasToken && !hasCreds) {
        console.log(chalk.yellow(`\nProvider '${provider}' is not configured`));
        console.log(
          chalk.gray("Use 'flui config list' to see configured providers\n"),
        );
        return;
      }

      if (!flags.force) {
        console.log(
          chalk.yellow(
            `\nWarning: This will remove the credentials for '${provider}'`,
          ),
        );
        const confirmed = await confirmByTypingPrompt(
          chalk.gray(`Type '${provider}' to confirm`),
          provider,
        );
        if (!confirmed) {
          console.log(chalk.gray('\nCancelled\n'));
          return;
        }
      }

      if (hasToken) storage.removeToken(provider);
      if (hasCreds) storage.removeCredentials(provider);
      console.log(chalk.green(`\nRemoved configuration for: ${provider}`));
      console.log(chalk.gray(`Location: ${storage.getConfigPath()}\n`));
    } catch (error) {
      console.log(chalk.red('\nFailed to remove configuration'));
      console.log(
        chalk.gray(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
      this.exit(1);
    }
  }
}
