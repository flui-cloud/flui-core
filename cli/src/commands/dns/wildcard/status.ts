import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ClusterWildcard, DnsClient } from '../../../lib/dns-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { printContextBanner } from '../../../lib/context-banner';

/**
 * Every application on a cluster is published at `<slug>.<cluster>.<zone>` and
 * resolves to the same address, so one wildcard record covers all of them —
 * including the ones that do not exist yet. Without it each new application
 * publishes a name of its own and waits about a minute for the world to see it,
 * on the one screen that shows the link to the application.
 */
export function describeWildcard(w: ClusterWildcard): string {
  switch (w.status) {
    case 'published':
      return `${chalk.green('covered')} by ${chalk.cyan(w.fqdn ?? '')} → ${w.expectedValue}`;
    case 'absent':
      return `${chalk.yellow('one record per application')} — each waits to propagate. Publish ${chalk.cyan(w.fqdn ?? '')} to stop that.`;
    case 'foreign':
      return `${chalk.yellow('a wildcard exists but points at')} ${w.actualValue}, not ${w.expectedValue} — left alone; applications keep their own records`;
    case 'unknown':
      return chalk.dim('the DNS provider could not be read just now');
    default:
      return chalk.dim('the cluster has no address yet');
  }
}

export default class DnsWildcardStatus extends Command {
  static readonly description =
    'Whether one DNS record covers every application on a cluster';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster production --json',
  ];
  static readonly flags = {
    cluster: Flags.string({ description: 'Cluster name or id' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsWildcardStatus);
    printContextBanner();

    const cluster = await resolveClusterRef(flags.cluster);
    const dns = DnsClient.fromConfig();
    const assignments = await dns.listAssignments(cluster.id);

    const rows = await Promise.all(
      assignments.map(async (a) => ({
        zone: a.dnsZone.zoneName,
        assignmentId: a.id,
        wildcardCertificate: a.wildcardCertificate,
        wildcard: await dns.getWildcard(cluster.id, a.id),
      })),
    );

    if (flags.json) {
      this.log(JSON.stringify({ cluster, zones: rows }, null, 2));
      return;
    }

    if (rows.length === 0) {
      this.log(
        chalk.yellow(
          `\n   ${cluster.name} has no DNS zone assigned — applications fall back to nip.io hostnames.\n`,
        ),
      );
      return;
    }

    this.log('');
    for (const row of rows) {
      this.log(`   ${chalk.bold(row.zone)}  ${chalk.dim(row.assignmentId)}`);
      this.log(`     applications  ${row.wildcard.hostnamePattern ?? '—'}`);
      this.log(`     dns           ${describeWildcard(row.wildcard)}`);
      this.log(
        `     certificate   ${row.wildcardCertificate ? chalk.green('wildcard') : chalk.dim('per application')}`,
      );
    }
    if (rows.some((r) => r.wildcard.status === 'absent')) {
      this.log(chalk.dim(`\n   Publish with: flui dns wildcard publish\n`));
    } else {
      this.log('');
    }
  }
}
