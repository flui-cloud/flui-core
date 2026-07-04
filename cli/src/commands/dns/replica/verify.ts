import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { DnsClient } from '../../../lib/dns-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class DnsReplicaVerify extends Command {
  static readonly description =
    'Dry-run a replica reconcile: report drift without changing anything';
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
    const { flags } = await this.parse(DnsReplicaVerify);
    printContextBanner();
    const spinner = ora('Verifying replica...').start();
    try {
      const report = await DnsClient.fromConfig().verifyReplica(
        flags.zone,
        flags.replica,
      );
      spinner.succeed('Verify complete');
      if (flags.json) {
        this.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log('');
      console.log(
        `  ${chalk.green(`+${report.created} would create`)}, ${chalk.cyan(`~${report.updated} would update`)}, ${chalk.yellow(`-${report.orphansDeleted} would remove`)}`,
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
      }
      console.log('');
      console.log(
        chalk.yellow(
          "  Dry-run only — nothing changed. Confirm with `dig @<replica-provider-ns> <a-record-fqdn>` before adding the provider's nameservers at your registrar.",
        ),
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Verify failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
