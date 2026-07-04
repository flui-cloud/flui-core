import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { DnsClient } from '../../../lib/dns-client';
import { confirmPrompt } from '../../../lib/prompts';
import { printContextBanner } from '../../../lib/context-banner';

export default class DnsReplicaRemove extends Command {
  static readonly description =
    'Remove a replica registration from Flui (provider records are left in place)';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --replica <replicaId>',
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --replica <replicaId> --force',
  ];
  static readonly flags = {
    zone: Flags.string({ required: true, description: 'DNS zone id' }),
    replica: Flags.string({ required: true, description: 'Replica id' }),
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Skip confirmation prompt',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsReplicaRemove);
    printContextBanner();
    console.log(
      chalk.dim(
        '  This removes only the Flui replica registration; records already written at the provider are left in place.',
      ),
    );
    if (!flags.force) {
      const ok = await confirmPrompt(
        chalk.yellow(
          `Remove replica ${flags.replica} from zone ${flags.zone}?`,
        ),
        false,
      );
      if (!ok) {
        console.log(chalk.green('\n  Cancelled.\n'));
        return;
      }
    }
    const spinner = ora('Removing replica...').start();
    try {
      await DnsClient.fromConfig().removeReplica(flags.zone, flags.replica);
      spinner.succeed(`Replica removed: ${flags.replica}`);
    } catch (error: any) {
      spinner.fail('Remove failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
