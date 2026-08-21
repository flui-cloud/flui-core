import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CatalogClient } from '../../lib/catalog-client';
import { printContextBanner } from '../../lib/context-banner';

export default class CatalogStatus extends Command {
  static readonly description = 'State of one catalog install';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <install-id>',
  ];
  static readonly args = {
    id: Args.string({ description: 'Install id', required: true }),
  };
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CatalogStatus);
    printContextBanner();

    const install = await CatalogClient.fromConfig().getInstall(args.id);
    if (flags.json) {
      this.log(JSON.stringify(install, null, 2));
      return;
    }

    this.log('');
    this.log(
      `   ${chalk.bold(install.displayName)}  ${chalk.dim(install.slug)}`,
    );
    this.log(`   state    ${install.status}`);
    if (install.resolvedFqdn) {
      this.log(`   url      https://${install.resolvedFqdn}`);
    }
    this.log(`   apps     ${install.applicationIds.length}`);
    if (install.errorMessage) {
      this.log(`   ${chalk.red('why')}      ${install.errorMessage}`);
    }
    this.log('');
  }
}
