import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { DnsClient } from '../../../lib/dns-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class DnsReplicaEnable extends Command {
  static readonly description =
    'Resume record fan-out to a previously disabled replica';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --replica <replicaId>',
  ];
  static readonly flags = {
    zone: Flags.string({ required: true, description: 'DNS zone id' }),
    replica: Flags.string({ required: true, description: 'Replica id' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsReplicaEnable);
    printContextBanner();
    const spinner = ora('Enabling replica...').start();
    try {
      const replica = await DnsClient.fromConfig().enableReplica(
        flags.zone,
        flags.replica,
      );
      spinner.succeed(`Replica enabled: ${replica.id}`);
      console.log(`  ${chalk.bold('Status:')} ${replica.status}`);
    } catch (error: any) {
      spinner.fail('Enable failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
