import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DnsClient } from '../../../lib/dns-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { resolveAssignment } from '../../../lib/resolve-dns-assignment';
import { printContextBanner } from '../../../lib/context-banner';
import { colorReconciliation } from './status';

/**
 * Re-applies what the cluster needs for a zone it already publishes under: the
 * DNS-01 credential Secrets, the issuer solvers covering every assigned zone,
 * and the wildcard record. The repair verb of a rebuild, and of any cluster
 * whose zone drifted.
 */
export default class DnsZoneReconcile extends Command {
  static readonly description =
    'Re-apply the cluster state a DNS zone assignment needs';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --zone dawit.blog --cluster production',
    '<%= config.bin %> <%= command.id %> --wait',
  ];
  static readonly flags = {
    cluster: Flags.string({ description: 'Cluster name or id' }),
    zone: Flags.string({
      description:
        'Zone name, assignment id or zone id, when several are assigned',
    }),
    wait: Flags.boolean({
      default: false,
      description: 'Poll until the assignment leaves RECONCILING',
    }),
    timeout: Flags.integer({
      default: 300,
      description: 'Seconds to wait with --wait',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsZoneReconcile);
    printContextBanner();

    const cluster = await resolveClusterRef(flags.cluster);
    const dns = DnsClient.fromConfig();
    const assignment = await resolveAssignment(dns, cluster, flags.zone);

    let current = await dns.reconcileAssignment(cluster.id, assignment.id);

    if (flags.wait) {
      current = await this.pollUntilSettled(
        dns,
        cluster.id,
        assignment.id,
        flags.timeout,
        current,
      );
    }

    if (flags.json) {
      this.log(JSON.stringify({ cluster, assignment: current }, null, 2));
      return;
    }

    this.log('');
    this.log(
      `   ${chalk.bold(assignment.dnsZone.zoneName)} on ${chalk.bold(cluster.name)}  ${chalk.dim(assignment.id)}`,
    );
    this.log(
      `   state    ${colorReconciliation(current.reconciliationStatus)}`,
    );
    if (current.errorMessage) {
      this.log(`   ${chalk.red('why')}      ${current.errorMessage}`);
    }
    this.log(
      flags.wait
        ? ''
        : chalk.dim(
            '\n   The cluster work runs in the background. Follow it with: flui dns zone status\n',
          ),
    );
  }

  /**
   * The route answers immediately in RECONCILING; the outcome arrives later.
   * Waiting is opt-in because a rebuild script wants the outcome and a person
   * checking in usually does not.
   */
  private async pollUntilSettled(
    dns: DnsClient,
    clusterId: string,
    assignmentId: string,
    timeoutSeconds: number,
    initial: Awaited<ReturnType<DnsClient['reconcileAssignment']>>,
  ) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let current = initial;
    while (
      current.reconciliationStatus === 'RECONCILING' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5000));
      const all = await dns.listAssignments(clusterId);
      const found = all.find((a) => a.id === assignmentId);
      if (!found) break;
      current = found;
    }
    if (current.reconciliationStatus === 'RECONCILING') {
      this.log(
        chalk.yellow(
          `\n   Still reconciling after ${timeoutSeconds}s — it keeps going without this command.`,
        ),
      );
    }
    return current;
  }
}
