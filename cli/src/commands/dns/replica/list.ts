import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DnsClient, DnsReplicaStatus } from '../../../lib/dns-client';
import { printContextBanner } from '../../../lib/context-banner';

function colorStatus(status: DnsReplicaStatus): string {
  switch (status) {
    case 'active':
      return chalk.green(status);
    case 'degraded':
      return chalk.red(status);
    case 'pending':
    case 'populating':
      return chalk.yellow(status);
    case 'disabled':
      return chalk.gray(status);
    default:
      return status;
  }
}

export default class DnsReplicaList extends Command {
  static readonly description =
    'List the dual-provider redundancy replicas of a DNS zone';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --zone <zoneId>',
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --json',
  ];
  static readonly flags = {
    zone: Flags.string({ required: true, description: 'DNS zone id' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsReplicaList);
    printContextBanner();
    const replicas = await DnsClient.fromConfig().listReplicas(flags.zone);
    if (flags.json) {
      this.log(JSON.stringify(replicas, null, 2));
      return;
    }
    if (replicas.length === 0) {
      this.log(chalk.yellow('\n   No replicas for this zone.\n'));
      return;
    }
    this.log('');
    for (const r of replicas) {
      this.log(
        `   ${chalk.cyan(r.id)}  ${r.dnsProvider}  ${colorStatus(r.status)}  ${chalk.dim(r.providerZoneId)}`,
      );
      if (r.lastReconciledAt) {
        this.log(`     ${chalk.dim(`last reconciled ${r.lastReconciledAt}`)}`);
      }
      if (r.errorMessage) {
        this.log(`     ${chalk.red(r.errorMessage)}`);
      }
    }
    this.log('');
  }
}
