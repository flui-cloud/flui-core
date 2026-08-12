import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface Connection {
  id: string;
  provider: string;
  scope: string;
  label: string;
  sendingDomain: string | null;
}

export default class MailUse extends Command {
  static readonly description =
    'Switch a scope onto a provider that is already configured';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 7f3c1b0e-...',
  ];

  static readonly args = {
    id: Args.string({
      description: 'Connection id, from `flui mail providers`',
      required: true,
    }),
  };

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MailUse);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) this.error('Not authenticated. Run `flui auth login` first.');

    const connection = await new ApiClient({
      baseUrl: apiUrl,
      apiKey,
    }).post<Connection>(`/mail/connections/${args.id}/activate`, {});

    if (flags.json) {
      this.log(JSON.stringify(connection, null, 2));
      return;
    }

    const from = connection.sendingDomain
      ? ` from ${connection.sendingDomain}`
      : '';
    this.log('');
    this.log(
      `  ${chalk.green('✓')} ${connection.label} now carries ${chalk.bold(connection.scope)} mail${from}.`,
    );
    // The one that stepped aside keeps its credential, so this is reversible
    // with the same command pointed the other way.
    this.log(
      chalk.dim(
        '    The provider it replaced keeps its credential and can be switched back.\n',
      ),
    );
  }
}
