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

export default class DnsZoneList extends Command {
  static readonly description =
    'List DNS zones and their dual-provider redundancy replicas';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];
  static readonly flags = { json: Flags.boolean({ default: false }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsZoneList);
    printContextBanner();
    const zones = await DnsClient.fromConfig().listZones();
    if (flags.json) {
      this.log(JSON.stringify(zones, null, 2));
      return;
    }
    if (zones.length === 0) {
      this.log(chalk.yellow('\n   No DNS zones.\n'));
      return;
    }
    this.log('');
    for (const z of zones) {
      this.log(
        `   ${z.zoneName}  ${chalk.cyan(z.id)}  ${z.dnsProvider}  ${chalk.dim(`TTL ${z.recordTtlSeconds}s`)}`,
      );
      for (const r of z.replicas) {
        this.log(
          `     ${chalk.dim('↳')} ${r.dnsProvider} ${colorStatus(r.status)} ${chalk.dim(`(${r.providerZoneId})`)}`,
        );
      }
    }
    this.log('');
  }
}
