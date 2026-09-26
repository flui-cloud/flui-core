import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DnsClient } from '../../lib/dns-client';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { printContextBanner } from '../../lib/context-banner';

export default class DnsResolvers extends Command {
  static readonly description =
    'Whether cert-manager checks names through public resolvers before asking for a certificate. ' +
    'Without them a name published a moment ago can be seen as missing for up to an hour. --pin sets them (cert-manager restarts once).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster production --pin',
  ];

  static readonly flags = {
    cluster: Flags.string({ description: 'Cluster name or id' }),
    pin: Flags.boolean({
      default: false,
      description: 'Set public resolvers when they are missing',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsResolvers);
    printContextBanner();

    const cluster = await resolveClusterRef(flags.cluster);
    const dns = DnsClient.fromConfig();
    const state = flags.pin
      ? await dns.pinAcmeResolvers(cluster.id)
      : await dns.getAcmeResolvers(cluster.id);

    if (flags.json) {
      this.log(
        JSON.stringify(
          { cluster: cluster.name, acmeResolvers: state },
          null,
          2,
        ),
      );
      return;
    }

    this.log('');
    if (!state) {
      this.log(
        chalk.yellow(`   cert-manager could not be read on ${cluster.name}.\n`),
      );
      return;
    }
    const mark = state.pinned ? chalk.green('✔') : chalk.yellow('!');
    this.log(`   ${mark} ${state.says}`);
    if (state.changed)
      this.log(chalk.dim('     Set just now; cert-manager restarts once.'));
    else if (!state.pinned)
      this.log(
        chalk.dim(
          `     Run ${chalk.cyan('flui dns resolvers --pin')} to set them.`,
        ),
      );
    this.log('');
  }
}
