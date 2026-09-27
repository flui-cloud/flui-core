import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupDestinationShow extends Command {
  static readonly description = 'Show a backup destination by ID';
  static readonly args = {
    id: Args.string({ required: true, description: 'Destination ID (UUID)' }),
  };
  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupDestinationShow);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const d = await client.getDestination(args.id);
    if (flags.json) {
      this.log(JSON.stringify(d, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold('ID:')}         ${d.id}`);
    this.log(`   ${chalk.bold('Name:')}       ${d.name}`);
    this.log(`   ${chalk.bold('Provider:')}   ${d.provider}`);
    this.log(`   ${chalk.bold('Endpoint:')}   ${d.endpoint}`);
    this.log(`   ${chalk.bold('Region:')}     ${d.region}`);
    this.log(`   ${chalk.bold('Bucket:')}     ${d.bucket}`);
    if (d.pathPrefix)
      this.log(`   ${chalk.bold('Prefix:')}     ${d.pathPrefix}`);
    if (d.encryptionMode)
      this.log(`   ${chalk.bold('Encryption:')} ${d.encryptionMode}`);
    if (d.health) this.log(`   ${chalk.bold('Health:')}     ${d.health}`);
    if (typeof d.usageBytes === 'number')
      this.log(
        `   ${chalk.bold('Usage:')}      ${(d.usageBytes / 1024 ** 3).toFixed(2)} GB`,
      );
    const priceSource =
      d.metadata?.costSource === 'list-price'
        ? chalk.dim(' (published list price)')
        : '';
    this.log(
      `   ${chalk.bold('Price:')}      ` +
        (d.costPerGbMonthCents == null
          ? chalk.dim('not set — flui backup destination set-cost')
          : `${d.costPerGbMonthCents} cents per GB per month` + priceSource),
    );
    this.log('');
  }
}
