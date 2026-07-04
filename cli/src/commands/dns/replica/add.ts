import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { DnsClient, DnsProviderName } from '../../../lib/dns-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class DnsReplicaAdd extends Command {
  static readonly description =
    'Register a secondary-provider replica for a DNS zone';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --provider scaleway',
    '<%= config.bin %> <%= command.id %> --zone <zoneId> --provider hetzner --provider-zone-id <id>',
  ];
  static readonly flags = {
    zone: Flags.string({ required: true, description: 'DNS zone id' }),
    provider: Flags.string({
      required: true,
      options: ['hetzner', 'scaleway'],
      description: 'Secondary DNS provider to replicate onto',
    }),
    'provider-zone-id': Flags.string({
      description:
        'Adopt an existing provider zone by id (optional; a new one is created when omitted)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DnsReplicaAdd);
    printContextBanner();
    const spinner = ora(`Registering ${flags.provider} replica...`).start();
    try {
      const replica = await DnsClient.fromConfig().registerReplica(flags.zone, {
        dnsProvider: flags.provider as DnsProviderName,
        providerZoneId: flags['provider-zone-id'],
      });
      spinner.succeed(`Replica registered: ${replica.id}`);
      console.log('');
      console.log(`  ${chalk.bold('Status:')} ${replica.status}`);
      console.log('');
      console.log(chalk.dim('  Next steps:'));
      console.log(
        chalk.dim(
          `     Run \`flui dns replica populate --zone ${flags.zone} --replica ${replica.id}\` to copy records,`,
        ),
      );
      console.log(
        chalk.dim(
          '     then `verify` and `dig @<ns>` before delegating nameservers at your registrar.',
        ),
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Replica registration failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
