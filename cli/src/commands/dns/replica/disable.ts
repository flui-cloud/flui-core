import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { DnsClient } from '../../../lib/dns-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class DnsReplicaDisable extends Command {
  static readonly description =
    'Pause record fan-out to a replica (provider records are left in place)';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --replica <replicaId>',
  ];
  static readonly flags = {
    zone: Flags.string({ required: true, description: 'DNS zone id' }),
    replica: Flags.string({ required: true, description: 'Replica id' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsReplicaDisable);
    printContextBanner();
    const spinner = ora('Disabling replica...').start();
    try {
      const replica = await DnsClient.fromConfig().disableReplica(
        flags.zone,
        flags.replica,
      );
      spinner.succeed(`Replica disabled: ${replica.id}`);
      console.log(`  ${chalk.bold('Status:')} ${replica.status}`);
    } catch (error: any) {
      spinner.fail('Disable failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
