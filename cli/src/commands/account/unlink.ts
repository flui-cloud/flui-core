import { Command } from '@oclif/core';
import { securityInDashboard } from '../../lib/account-view';

export default class AccountUnlink extends Command {
  static readonly description =
    "Remove a GitHub or Google sign-in: done on the dashboard's Account page, signed in as yourself.";

  static readonly strict = false;

  async run(): Promise<void> {
    this.error(securityInDashboard('linked sign-ins'), { exit: 1 });
  }
}
