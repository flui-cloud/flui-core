import { Command } from '@oclif/core';
import { securityInDashboard } from '../../lib/account-view';

export default class AccountRemovePasskey extends Command {
  static readonly description =
    "Remove a passkey or security key: done on the dashboard's Account page, signed in as yourself.";

  static readonly strict = false;

  async run(): Promise<void> {
    this.error(securityInDashboard('passkeys and security keys'), { exit: 1 });
  }
}
