import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SandboxClient, SignInProvider } from '../../../lib/sandbox-client';
import { printContextBanner } from '../../../lib/context-banner';
import {
  SIGN_IN_PROVIDERS,
  SIGN_IN_PROVIDER_NAMES,
} from '../../../lib/sandbox-sign-in';

export default class SandboxSignInDisconnect extends Command {
  static readonly description =
    'Take GitHub or Google sign-in off a demo and delete its credentials from the identity provider';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> github --yes',
  ];

  static readonly args = {
    provider: Args.string({
      description: 'Sign-in provider',
      required: true,
      options: [...SIGN_IN_PROVIDERS],
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      default: false,
      description:
        'Required. Guests can no longer sign in with this provider, including those who already did.',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSignInDisconnect);
    const provider = args.provider as SignInProvider;
    const name = SIGN_IN_PROVIDER_NAMES[provider];
    printContextBanner();

    if (!flags.yes) {
      this.log('');
      this.log(
        `  Disconnecting ${chalk.bold(name)} removes its button from the sign-in page and deletes its credentials.`,
      );
      this.log(
        '  Guests who signed in with it can no longer do so; connecting it again is `flui sandbox sign-in connect`.',
      );
      this.log('');
      this.log(chalk.dim('  Re-run with --yes to go ahead.\n'));
      return;
    }

    const status =
      await SandboxClient.fromConfig().disconnectSignInProvider(provider);
    if (flags.json) {
      this.log(JSON.stringify(status, null, 2));
      return;
    }
    this.log(`\n  ${chalk.green('✓')} ${name} sign-in disconnected.\n`);
  }
}
