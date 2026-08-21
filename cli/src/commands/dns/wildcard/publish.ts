import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DnsClient } from '../../../lib/dns-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { printContextBanner } from '../../../lib/context-banner';
import { describeWildcard } from './status';

export default class DnsWildcardPublish extends Command {
  static readonly description =
    'Publish the record that covers every application on a cluster';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster production',
  ];
  static readonly flags = {
    cluster: Flags.string({ description: 'Cluster name or id' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsWildcardPublish);
    printContextBanner();

    const cluster = await resolveClusterRef(flags.cluster);
    const dns = DnsClient.fromConfig();
    const assignments = await dns.listAssignments(cluster.id);

    if (assignments.length === 0) {
      this.error(
        `${cluster.name} has no DNS zone assigned — nothing to publish into.`,
      );
    }

    const results = await Promise.all(
      assignments.map(async (a) => ({
        zone: a.dnsZone.zoneName,
        wildcard: await dns.publishWildcard(cluster.id, a.id),
      })),
    );

    if (flags.json) {
      this.log(JSON.stringify({ cluster, zones: results }, null, 2));
      return;
    }

    this.log('');
    for (const r of results) {
      this.log(`   ${chalk.bold(r.zone)}  ${describeWildcard(r.wildcard)}`);
    }
    // Said plainly because it is the whole reason to run this, and because it
    // is not instant: an existing wildcard is already cached by resolvers, a
    // brand-new one still has to reach them once.
    if (results.some((r) => r.wildcard.status === 'published')) {
      this.log(
        chalk.dim(
          '\n   From now on a new application answers as soon as it is deployed,\n' +
            '   instead of waiting for its own name to propagate.\n',
        ),
      );
    } else {
      this.log('');
    }
  }
}
