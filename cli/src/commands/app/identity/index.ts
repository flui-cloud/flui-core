import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../../lib/identity-client';
import { resolveAppOnAnyCluster } from '../../../lib/resolve-app';

export default class AppIdentity extends Command {
  static readonly description =
    'Which identity install an application signs its users in with';
  static readonly examples = ['<%= config.bin %> <%= command.id %> my-shop'];
  static readonly args = {
    app: Args.string({ description: 'Application name or id', required: true }),
  };
  static readonly flags = {
    from: Flags.string({
      description:
        'Cluster the application runs on, when the name is ambiguous',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppIdentity);
    const app = await resolveAppOnAnyCluster(args.app, flags.from);
    const link = await IdentityClient.fromConfig().link(app.id);
    if (flags.json) {
      this.log(JSON.stringify(link, null, 2));
      return;
    }
    if (!link) {
      this.log(
        chalk.dim(`${app.name} signs nobody in through an identity install.`),
      );
      return;
    }
    this.log('');
    this.log(`   issuer        ${link.issuer}`);
    this.log(`   client id     ${link.clientId}`);
    this.log(`   returns to    ${link.redirectUris.join(', ')}`);
    this.log(
      `   variables     ${link.envNames.issuer}, ${link.envNames.clientId}, ${link.envNames.clientSecret} ${chalk.dim('(secret)')}`,
    );
    this.log('');
  }
}
