import { Command, Flags } from '@oclif/core';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { MailIdentityStatus } from '../../../lib/mail-identity';
import { printMailIdentity } from '../../../lib/mail-identity-print';

export default class MailIdentity extends Command {
  static readonly description =
    'Show whether sign-in emails (verification, password reset) are sent through Flui';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = {
    json: Flags.boolean({
      description: 'Print the raw response',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(MailIdentity);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not authenticated. Run `flui auth login` first.');
    }

    let status: MailIdentityStatus;
    try {
      status = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).get<MailIdentityStatus>('/mail/identity');
    } catch (error) {
      this.error((error as Error).message);
    }

    if (flags.json) {
      this.log(JSON.stringify(status, null, 2));
      return;
    }
    printMailIdentity((line) => this.log(line), status);
  }
}
