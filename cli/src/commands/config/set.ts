import { Command, Args } from '@oclif/core';
import chalk from 'chalk';
import { ConfigStorage } from '../../lib/config-storage';
import { classifyKey, formatKnownKeys } from '../../config/key-router';
import { PREFERENCES, PreferenceKey } from '../../config/preferences-schema';
import { PreferencesResolver } from '../../config/preferences-resolver';
import {
  getCredentialSchema,
  isCompoundProvider,
} from '../../lib/provider-credential-schemas';
import { promptInput, promptMaskedInput } from '../../lib/prompts';
import { validateScalewayCredentials } from '../../lib/scaleway-validator';

export default class ConfigSet extends Command {
  static readonly description =
    'Set a configuration value. The key determines whether it is stored as a non-secret preference (e.g. email, certificateMode), an encrypted provider token (e.g. hetzner), or a system override (api-url — the Flui API base URL the CLI talks to). Run with an unknown key to list every accepted key.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> hetzner YOUR_API_TOKEN',
    '<%= config.bin %> <%= command.id %> email you@example.com',
    '<%= config.bin %> <%= command.id %> certificateMode preflight',
    '<%= config.bin %> <%= command.id %> api-url http://localhost:3000/api/v1',
  ];

  static readonly args = {
    key: Args.string({
      required: true,
      description:
        'Configuration key: a preference, a provider name, or a system override (api-url)',
    }),
    value: Args.string({
      required: false,
      description:
        'Value to store. Omit for compound providers (e.g. scaleway) to enter values interactively.',
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigSet);

    try {
      const storage = new ConfigStorage();
      const kind = classifyKey(args.key);

      switch (kind) {
        case 'preference':
          if (!args.value) {
            console.log(
              chalk.red(`\nMissing value for preference '${args.key}'\n`),
            );
            this.exit(1);
          }
          this.setPreference(storage, args.key as PreferenceKey, args.value);
          return;
        case 'provider':
          await this.setProvider(storage, args.key.toLowerCase(), args.value);
          return;
        case 'system':
          if (!args.value) {
            console.log(chalk.red(`\nMissing value for '${args.key}'\n`));
            this.exit(1);
          }
          this.setSystem(storage, args.key.toLowerCase(), args.value);
          return;
        case 'unknown':
          this.failUnknown(args.key);
          return;
      }
    } catch (error) {
      console.log(chalk.red('\nFailed to save configuration'));
      console.log(
        chalk.gray(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
      this.exit(1);
    }
  }

  private setPreference(
    storage: ConfigStorage,
    key: PreferenceKey,
    value: string,
  ): void {
    const validationError = PreferencesResolver.validate(key, value);
    if (validationError) {
      console.log(
        chalk.red(`\nInvalid value for '${key}': ${validationError}\n`),
      );
      this.exit(1);
    }
    storage.setPreference(key, value);
    console.log(chalk.green(`\nPreference saved: ${key} = ${value}`));
    console.log(chalk.gray(`Location: ${storage.getConfigPath()}`));
    console.log(chalk.gray(`Description: ${PREFERENCES[key].description}\n`));
  }

  private async setProvider(
    storage: ConfigStorage,
    provider: string,
    value: string | undefined,
  ): Promise<void> {
    const schema = getCredentialSchema(provider);

    if (isCompoundProvider(provider)) {
      if (value) {
        console.log(
          chalk.red(
            `\n'${provider}' requires an Access Key + Secret Key pair — pass no value and enter them interactively.\n`,
          ),
        );
        this.exit(1);
      }
      await this.setCompoundProvider(storage, provider, schema);
      return;
    }

    if (!value) {
      console.log(chalk.red(`\nMissing token for provider '${provider}'\n`));
      this.exit(1);
    }
    storage.saveToken(provider, value);
    console.log(chalk.green(`\nProvider configured: ${provider}`));
    console.log(chalk.gray(`Location: ${storage.getConfigPath()}`));
    console.log(chalk.gray('Encryption: AES-256-GCM\n'));
    console.log(chalk.gray(`Next: flui env create\n`));
  }

  private async setCompoundProvider(
    storage: ConfigStorage,
    provider: string,
    schema: NonNullable<ReturnType<typeof getCredentialSchema>>,
  ): Promise<void> {
    console.log(
      chalk.dim(
        `\nEnter ${provider} credentials. Values are stored AES-256-GCM encrypted.\n`,
      ),
    );

    const collected: Record<string, string> = {};
    for (const field of schema.fields) {
      const hintLabel = field.hint ? chalk.dim(` (${field.hint})`) : '';
      const value = field.secret
        ? await promptMaskedInput(`  ${field.label}`)
        : (
            await promptInput({
              message: `  ${field.label}${hintLabel}`,
            })
          ).trim();
      if (!value.trim()) {
        console.log(chalk.red(`\n${field.label} is required.\n`));
        this.exit(1);
      }
      collected[field.key] = value.trim();
    }

    if (provider === 'scaleway') {
      process.stdout.write(chalk.dim('\nValidating credentials...'));
      const result = await validateScalewayCredentials(
        collected.accessKey,
        collected.secretKey,
      );
      process.stdout.write('\r\u001B[2K');
      if (!result.success) {
        console.log(chalk.red(`✖ ${result.message}\n`));
        this.exit(1);
      }
      console.log(chalk.green(`✔ ${result.message}`));
    }

    storage.saveCredentials(provider, collected);
    console.log(chalk.green(`\nProvider configured: ${provider}`));
    console.log(chalk.gray(`Location: ${storage.getConfigPath()}`));
    console.log(chalk.gray('Encryption: AES-256-GCM\n'));
    console.log(chalk.gray(`Next: flui env create\n`));
  }

  private setSystem(storage: ConfigStorage, key: string, value: string): void {
    if (key === 'api-url') {
      try {
        new URL(value);
      } catch {
        console.log(chalk.red(`\nInvalid URL: ${value}\n`));
        this.exit(1);
      }
      storage.saveApiUrl(value);
      console.log(chalk.green(`\nAPI URL saved: ${value}`));
      console.log(chalk.gray(`Location: ${storage.getConfigPath()}\n`));
      return;
    }
    this.failUnknown(key);
  }

  private failUnknown(key: string): void {
    console.log(chalk.red(`\nUnknown configuration key: '${key}'\n`));
    console.log(formatKnownKeys());
    console.log();
    this.exit(1);
  }
}
