import { Command, Flags } from '@oclif/core';
import { AccountClient, AccountOverview } from '../../lib/account-client';
import { overviewLines } from '../../lib/account-view';

export default class Account extends Command {
  static readonly description =
    'Show your own account: name, email, password, authenticator app, passkeys and linked sign-ins.\n' +
    'Change your name with `flui account profile`. How your account signs in is changed on the\n' +
    "dashboard's Account page, signed in as yourself.";

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly enableJsonFlag = true;

  static readonly flags = {
    profile: Flags.string({
      description:
        'Profile to read the credential from (default: active profile)',
    }),
  };

  async run(): Promise<AccountOverview> {
    const { flags } = await this.parse(Account);
    try {
      const view = await AccountClient.fromConfig(flags.profile).overview();
      if (!this.jsonEnabled())
        for (const line of overviewLines(view)) this.log(line);
      return view;
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e), { exit: 1 });
    }
  }
}
