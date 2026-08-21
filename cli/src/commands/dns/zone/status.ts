import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ClusterZoneAssignment, DnsClient } from '../../../lib/dns-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { printContextBanner } from '../../../lib/context-banner';

export function colorReconciliation(status: string): string {
  switch (status) {
    case 'IN_SYNC':
      return chalk.green(status);
    case 'ERROR':
      return chalk.red(status);
    case 'DRIFT':
      return chalk.yellow(status);
    case 'RECONCILING':
    case 'PENDING':
      return chalk.cyan(status);
    default:
      return status;
  }
}

function describeAge(iso?: string | null): string {
  if (!iso) return chalk.dim('never reconciled');
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return chalk.dim(String(iso));
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return chalk.dim('just now');
  if (minutes < 60) return chalk.dim(`${minutes}m ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return chalk.dim(`${hours}h ago`);
  return chalk.dim(`${Math.round(hours / 24)}d ago`);
}

export default class DnsZoneStatus extends Command {
  static readonly description =
    'Reconciliation state of the DNS zones a cluster publishes under';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster production --json',
  ];
  static readonly flags = {
    cluster: Flags.string({ description: 'Cluster name or id' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsZoneStatus);
    printContextBanner();

    const cluster = await resolveClusterRef(flags.cluster);
    const assignments = await DnsClient.fromConfig().listAssignments(
      cluster.id,
    );

    if (flags.json) {
      this.log(JSON.stringify({ cluster, assignments }, null, 2));
      return;
    }

    if (assignments.length === 0) {
      this.log(
        chalk.yellow(
          `\n   ${cluster.name} has no DNS zone assigned — applications fall back to nip.io hostnames.` +
            `\n   Assign one with: flui dns zone assign <zone>\n`,
        ),
      );
      return;
    }

    this.log('');
    for (const a of assignments as ClusterZoneAssignment[]) {
      this.log(`   ${chalk.bold(a.dnsZone.zoneName)}  ${chalk.dim(a.id)}`);
      this.log(
        `     state         ${colorReconciliation(a.reconciliationStatus)}  ${describeAge(a.lastReconciliationAt)}`,
      );
      this.log(
        `     certificate   ${a.wildcardCertificate ? chalk.green('wildcard') : chalk.dim('per application')}` +
          (a.certificateProvider
            ? `  ${chalk.dim(a.certificateProvider)}`
            : ''),
      );
      this.log(`     provider      ${a.dnsZone.dnsProvider}`);
      if (a.errorMessage) {
        this.log(`     ${chalk.red('why')}           ${a.errorMessage}`);
      }
    }

    if (assignments.some((a) => a.reconciliationStatus !== 'IN_SYNC')) {
      this.log(chalk.dim('\n   Re-apply with: flui dns zone reconcile\n'));
    } else {
      this.log('');
    }
  }
}
