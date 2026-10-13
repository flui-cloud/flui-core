import { Command, Flags } from '@oclif/core';
import ora from 'ora';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { MailIdentityStatus } from '../../../lib/mail-identity';
import { printMailIdentity } from '../../../lib/mail-identity-print';

export default class MailIdentitySync extends Command {
  static readonly description =
    'Point the identity provider at Flui for its sign-in emails now. Safe to repeat.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({
      description: 'Print the raw response',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailIdentitySync);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not authenticated. Run `flui auth login` first.');
    }

    const spinner = ora('Syncing with the identity provider...').start();
    let status: MailIdentityStatus;
    try {
      status = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).post<MailIdentityStatus>('/mail/identity/sync', {});
      spinner.stop();
    } catch (error) {
      spinner.fail('Could not sync');
      this.error((error as Error).message);
    }

    if (flags.json) {
      this.log(JSON.stringify(status, null, 2));
      return;
    }
    printMailIdentity((line) => this.log(line), status);
  }
}
