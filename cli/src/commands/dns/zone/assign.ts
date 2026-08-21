import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DnsClient } from '../../../lib/dns-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { resolveZone } from '../../../lib/resolve-dns-assignment';
import { printContextBanner } from '../../../lib/context-banner';
import { colorReconciliation } from './status';

/**
 * Binding a zone to a cluster is what makes applications answer at
 * `<slug>.<cluster>.<zone>` instead of at a nip.io name. It is done once per
 * cluster and again at every rebuild — which is why it cannot live only on a
 * screen.
 */
export default class DnsZoneAssign extends Command {
  static readonly description =
    'Publish a cluster’s applications under a registered DNS zone';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> dawit.blog',
    '<%= config.bin %> <%= command.id %> dawit.blog --cluster production --acme-email me@example.com',
    '<%= config.bin %> <%= command.id %> dawit.blog --no-wildcard-certificate',
  ];
  static readonly args = {
    zone: Args.string({
      description: 'Zone name or id, as listed by `flui dns zone list`',
      required: true,
    }),
  };
  static readonly flags = {
    cluster: Flags.string({ description: 'Cluster name or id' }),
    'acme-email': Flags.string({
      description: 'Email registered with the ACME certificate authority',
    }),
    'certificate-provider': Flags.string({
      description: 'Certificate authority to issue from',
      options: ['lets_encrypt', 'lets_encrypt_staging'],
    }),
    'wildcard-certificate': Flags.boolean({
      default: true,
      allowNo: true,
      description:
        'One certificate covering every application, instead of one each',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DnsZoneAssign);
    printContextBanner();

    const cluster = await resolveClusterRef(flags.cluster);
    const dns = DnsClient.fromConfig();
    const zone = await resolveZone(dns, args.zone);

    const assignment = await dns.assignZone(cluster.id, {
      dnsZoneId: zone.id,
      acmeEmail: flags['acme-email'],
      certificateProvider: flags['certificate-provider'],
      wildcardCertificate: flags['wildcard-certificate'],
    });

    if (flags.json) {
      this.log(JSON.stringify({ cluster, assignment }, null, 2));
      return;
    }

    this.log('');
    this.log(
      `   ${chalk.green('assigned')} ${chalk.bold(zone.zoneName)} to ${chalk.bold(cluster.name)}  ${chalk.dim(assignment.id)}`,
    );
    this.log(
      `   state    ${colorReconciliation(assignment.reconciliationStatus)}`,
    );
    // The cluster work — DNS-01 secrets, issuer solvers, the wildcard record —
    // runs in the background, so this answer is a starting point.
    this.log(chalk.dim('\n   Follow it with: flui dns zone status\n'));
  }
}
