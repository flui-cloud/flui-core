import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { IdentityClient } from '../../lib/identity-client';
import { printContextBanner } from '../../lib/context-banner';

export default class IdentityInstalls extends Command {
  static readonly description =
    'Identity installs you can read, to sign your apps’ users in with';
  static readonly examples = ['<%= config.bin %> <%= command.id %>'];
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(IdentityInstalls);
    const installs = await IdentityClient.fromConfig().installs();
    if (flags.json) {
      this.log(JSON.stringify(installs, null, 2));
      return;
    }
    printContextBanner();
    if (installs.length === 0) {
      this.log(
        chalk.dim(
          '\n   None. Install Zitadel from the catalog to sign your apps’ users in.\n',
        ),
      );
      return;
    }
    this.log('');
    for (const i of installs) {
      const note = i.managed
        ? ''
        : chalk.yellow('  reinstall to manage from Flui');
      this.log(
        `   ${i.name.padEnd(28)} ${chalk.dim(i.identityInstallId)}  ${i.issuer ?? chalk.dim('no address yet')}${note}`,
      );
    }
    this.log('');
  }
}
