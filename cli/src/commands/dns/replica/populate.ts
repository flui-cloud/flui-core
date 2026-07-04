import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { DnsClient } from '../../../lib/dns-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class DnsReplicaPopulate extends Command {
  static readonly description =
    'Copy every zone record into a replica (applies changes at the provider)';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --replica <replicaId>',
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --replica <replicaId> --json',
  ];
  static readonly flags = {
    zone: Flags.string({ required: true, description: 'DNS zone id' }),
    replica: Flags.string({ required: true, description: 'Replica id' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsReplicaPopulate);
    printContextBanner();
    const spinner = ora('Populating replica...').start();
    let hadErrors = false;
    try {
      const report = await DnsClient.fromConfig().populateReplica(
        flags.zone,
        flags.replica,
      );
      spinner.succeed('Populate complete');
      if (flags.json) {
        this.log(JSON.stringify(report, null, 2));
        hadErrors = report.errors.length > 0;
      } else {
        console.log('');
        console.log(
          `  ${chalk.green(`+${report.created} created`)}, ${chalk.cyan(`~${report.updated} updated`)}, ${chalk.yellow(`-${report.orphansDeleted} removed`)}`,
        );
        if (report.mismatches.length) {
          console.log('');
          console.log(chalk.bold('  Mismatches:'));
          for (const m of report.mismatches) {
            console.log(
              `     ${m.name} ${m.type}  expected ${chalk.cyan(m.expected)}  actual ${chalk.red(m.actual)}`,
            );
          }
        }
        if (report.errors.length) {
          console.log('');
          for (const e of report.errors) {
            console.log(chalk.red(`  ${e}`));
          }
          hadErrors = true;
        }
        console.log('');
      }
    } catch (error: any) {
      spinner.fail('Populate failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
    if (hadErrors) this.exit(1);
  }
}
