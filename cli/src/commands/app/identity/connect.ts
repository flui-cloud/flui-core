import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../../lib/identity-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppIdentityConnect extends Command {
  static readonly description =
    'Sign an application’s users in with an identity install. The application receives only the issuer, client id and client secret, and is redeployed.';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-shop --install <install-id> --redirect /auth/callback',
    '<%= config.bin %> <%= command.id %> my-shop --install <install-id> --redirect /cb --client-secret-var AUTH_SECRET',
  ];
  static readonly args = {
    app: Args.string({ description: 'Application name or id', required: true }),
  };
  static readonly flags = {
    install: Flags.string({
      required: true,
      description: 'Identity install id',
    }),
    redirect: Flags.string({
      required: true,
      multiple: true,
      description:
        'Path on the application’s address to come back to after sign-in (repeatable)',
    }),
    'issuer-var': Flags.string({
      description: 'Variable for the issuer (default OIDC_ISSUER)',
    }),
    'client-id-var': Flags.string({
      description: 'Variable for the client id (default OIDC_CLIENT_ID)',
    }),
    'client-secret-var': Flags.string({
      description:
        'Variable for the client secret (default OIDC_CLIENT_SECRET)',
    }),
    from: Flags.string({
      description:
        'Cluster the application runs on, when the name is ambiguous',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppIdentityConnect);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    const link = await IdentityClient.fromConfig().connect(app.id, {
      identityInstallId: flags.install,
      redirectPaths: flags.redirect,
      envNames: {
        issuer: flags['issuer-var'],
        clientId: flags['client-id-var'],
        clientSecret: flags['client-secret-var'],
      },
    });
    this.log(
      `${chalk.green('✔')} ${app.name} signs its users in at ${link.issuer}`,
    );
    this.log(
      chalk.dim(
        `  Redeploying with ${link.envNames.issuer}, ${link.envNames.clientId} and ${link.envNames.clientSecret}.`,
      ),
    );
  }
}
