import { Command, Flags } from '@oclif/core';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';
import {
  CONSOLE_MINUTES,
  IdentityConsoleStatus,
} from '../../../lib/identity-console';
import { printIdentityConsole } from '../../../lib/identity-console-print';

export default class IdentityConsoleOpen extends Command {
  static readonly description =
    "Open the identity provider's console for a limited time. It closes by itself; the opening is audited.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --reason "change the organisation password policy"',
    '<%= config.bin %> <%= command.id %> --minutes 30 --reason "inspect a locked user"',
  ];

  static readonly flags = {
    minutes: Flags.integer({
      description: `How long it stays open (${CONSOLE_MINUTES.min}-${CONSOLE_MINUTES.max})`,
      default: CONSOLE_MINUTES.default,
      min: CONSOLE_MINUTES.min,
      max: CONSOLE_MINUTES.max,
    }),
    reason: Flags.string({
      description: 'Why it is being opened, kept in the audit log',
      required: true,
    }),
    json: Flags.boolean({
      description: 'Print the raw response',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IdentityConsoleOpen);
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
      }).post<IdentityConsoleStatus>('/identity/console/open', {
        minutes: flags.minutes,
        reason: flags.reason,
      });
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
