import { Command } from '@oclif/core';
import { securityInDashboard } from '../../lib/account-view';

export default class AccountTotp extends Command {
  static readonly description =
    "Set up or remove your authenticator app: done on the dashboard's Account page, signed in as yourself.";

  static readonly strict = false;

  async run(): Promise<void> {
    this.error(securityInDashboard('the authenticator app'), { exit: 1 });
  }
}
