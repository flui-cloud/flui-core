import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  SandboxClient,
  SignInProvider,
  SignInProviders,
} from '../../../lib/sandbox-client';
import { printContextBanner } from '../../../lib/context-banner';
import { promptInput } from '../../../lib/prompts';
import { refuseToAsk } from '../../../lib/non-interactive';
import {
  OAUTH_APP_HELP,
  callbackLines,
  SIGN_IN_PROVIDERS,
  SignInCredentialsError,
  collectSignInCredentials,
} from '../../../lib/sandbox-sign-in';

/**
 * Hands GitHub or Google OAuth credentials to the demo's identity provider.
 *
 * There is no flag for the client secret, on purpose: a flag lands in the shell
 * history and in `ps`. It is asked for at a prompt that does not echo, or read
 * from standard input with `--stdin`, and goes in one request to the identity
 * provider, which keeps it encrypted. Flui stores nothing of it, so it cannot be
 * shown again; running this again replaces it.
 */
export default class SandboxSignInConnect extends Command {
  static readonly description =
    'Connect GitHub or Google sign-in for the guests of a demo, or give it new credentials. The client secret is prompted for (or read from standard input) and goes only to the identity provider.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> github',
    '<%= config.bin %> <%= command.id %> google --client-id 1234-abc.apps.googleusercontent.com',
    'printf \'%s\' "$SECRET" | <%= config.bin %> <%= command.id %> github --client-id Iv23li... --stdin',
  ];

  static readonly args = {
    provider: Args.string({
      description: 'Sign-in provider',
      required: true,
      options: [...SIGN_IN_PROVIDERS],
    }),
  };

  static readonly flags = {
    'client-id': Flags.string({
      description:
        'The OAuth client ID. Public, so a flag is fine; asked for when left out.',
    }),
    stdin: Flags.boolean({
      description:
        'Read the client secret from standard input rather than prompting. Requires --client-id.',
      default: false,
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxSignInConnect);
    const provider = args.provider as SignInProvider;
    printContextBanner();

    const sandbox = SandboxClient.fromConfig();
    const view = await sandbox.listSignInProviders();
    if (!view.demo) {
      this.error(
        'This installation is not a demo. GitHub and Google sign-in is only offered on one.',
        { exit: 1 },
      );
    }
    if (!flags.json) this.printHelp(provider, view);
    const fromVariables =
      view.providers.find((p) => p.provider === provider)?.source ===
      'environment';

    let credentials: { clientId: string; clientSecret: string };
    try {
      credentials = await collectSignInCredentials(provider, {
        clientId: flags['client-id'],
        askClientId: (label) => {
          refuseToAsk(
            label,
            `Pass it with --client-id, and the secret on standard input with --stdin.`,
          );
          return promptInput({ message: label });
        },
      });
    } catch (error) {
      if (error instanceof SignInCredentialsError) {
        this.error(error.message, { exit: 1 });
      }
      throw error;
    }

    const status = await sandbox.connectSignInProvider(provider, credentials);

    if (flags.json) {
      this.log(JSON.stringify(status, null, 2));
      return;
    }
    this.log(
      chalk.green(
        `\n✅ ${status.name} sign-in is connected${status.onSignInPage ? ' and shown on the sign-in page' : ''}.`,
      ),
    );
    this.log(
      chalk.dim(
        '   The secret went to the identity provider only. It is not shown here and cannot be read back; running this again replaces it.',
      ),
    );
    if (fromVariables) {
      const prefix = `SANDBOX_${provider.toUpperCase()}_CLIENT`;
      this.log(
        chalk.yellow(
          `\n   Now remove ${prefix}_ID and ${prefix}_SECRET from the configuration: they are ignored from here on, and the secret should not stay there.`,
        ),
      );
    }
    this.log('');
  }

  private printHelp(provider: SignInProvider, view: SignInProviders): void {
    this.log('');
    for (const line of OAUTH_APP_HELP[provider]) this.log(`   ${line}`);
    const lines = callbackLines(provider, view);
    if (lines.length) this.log('');
    for (const [label, url] of lines) {
      this.log(`   ${label.padEnd(13)} ${chalk.bold(url)}`);
    }
    const current = view.providers.find((p) => p.provider === provider);
    if (current?.connected) {
      this.log(
        chalk.yellow(
          `\n   ${current.name} is already connected (client ID ${current.clientId ?? 'unknown'}): this replaces its credentials.`,
        ),
      );
    }
    this.log('');
  }
}
