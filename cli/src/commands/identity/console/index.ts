import { Command, Flags } from '@oclif/core';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import { IdentityConsoleStatus } from '../../../lib/identity-console';
import { printIdentityConsole } from '../../../lib/identity-console-print';

export default class IdentityConsole extends Command {
  static readonly description =
    "Show whether the identity provider's console is open (closed by default; sign-in is unaffected)";

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
    const { flags } = await this.parse(IdentityConsole);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not authenticated. Run `flui auth login` first.');
    }

    let status: IdentityConsoleStatus;
    try {
      status = await new ApiClient({
        baseUrl: apiUrl,
        apiKey,
      }).get<IdentityConsoleStatus>('/identity/console');
    } catch (error) {
      this.error((error as Error).message);
    }

    if (flags.json) {
      this.log(JSON.stringify(status, null, 2));
      return;
    }
    printIdentityConsole((line) => this.log(line), status);
  }
}
