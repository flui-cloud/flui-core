import { Command } from '@oclif/core';
import { securityInDashboard } from '../../lib/account-view';

export default class AccountPassword extends Command {
  static readonly description =
    "Change your password: done on the dashboard's Account page, signed in as yourself.";

  static readonly strict = false;

  async run(): Promise<void> {
    this.error(securityInDashboard('your password'), { exit: 1 });
  }
}
