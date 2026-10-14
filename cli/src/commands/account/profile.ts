import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { AccountClient } from '../../lib/account-client';

export default class AccountProfile extends Command {
  static readonly description =
    'Change your own first, last and display name. Names you leave out keep their current value.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --first-name Ada --last-name Lovelace',
    '<%= config.bin %> <%= command.id %> --display-name "Ada L."',
  ];

  static readonly flags = {
    'first-name': Flags.string({ description: 'First name' }),
    'last-name': Flags.string({ description: 'Last name' }),
    'display-name': Flags.string({ description: 'Name shown to others' }),
    profile: Flags.string({
      description:
        'Profile to read the credential from (default: active profile)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AccountProfile);
    if (!flags['first-name'] && !flags['last-name'] && !flags['display-name']) {
      this.error(
        'Pass at least one of --first-name, --last-name, --display-name.',
        {
          exit: 2,
        },
      );
    }
    try {
      const client = AccountClient.fromConfig(flags.profile);
      const current = (await client.overview()).profile;
      const firstName = flags['first-name'] ?? current.firstName ?? '';
      const lastName = flags['last-name'] ?? current.lastName ?? '';
      const keepDisplay =
        !flags['first-name'] && !flags['last-name']
          ? current.displayName
          : undefined;
      const saved = await client.updateProfile({
        firstName,
        lastName,
        displayName: flags['display-name'] ?? keepDisplay ?? undefined,
      });
      this.log(
        chalk.green(
          `✔ Name saved: ${saved.displayName ?? `${firstName} ${lastName}`}`,
        ),
      );
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e), { exit: 1 });
    }
  }
}
