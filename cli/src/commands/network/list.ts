import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface VNetSummary {
  id: string;
  name: string;
  provider: string;
  ipRange: string;
  implementation?: string;
  status: string;
  subnets?: Array<{ id: string; ipRange: string; networkZone?: string }>;
}

export default class NetworkList extends Command {
  static readonly description =
    'List the private networks of this installation, with the subnets a ' +
    'cluster can be attached to.';

  static readonly summary = 'List private networks';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --provider hetzner',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    provider: Flags.string({
      description: 'Only networks on this provider',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(NetworkList);

    const configStorage = new ConfigStorage();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const apiClient = new ApiClient({
      baseUrl: configStorage.getApiUrlOrThrow(),
      apiKey,
    });

    const spinner = ora('Fetching private networks...').start();
    let vnets: VNetSummary[];
    try {
      const query = flags.provider
        ? `?provider=${encodeURIComponent(flags.provider)}`
        : '';
      const res = await apiClient.get<{ vnets?: VNetSummary[] }>(
        `/vnets${query}`,
      );
      vnets = res.vnets ?? [];
      spinner.stop();
    } catch (error: any) {
      spinner.fail('Could not list private networks');
      console.log(
        chalk.red(
          `\n  Error: ${error.response?.data?.message ?? error.message}\n`,
        ),
      );
      this.exit(1);
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify({ vnets }, null, 2));
      return;
    }

    if (vnets.length === 0) {
      console.log(chalk.dim('\n  No private networks.\n'));
      return;
    }

    console.log('');
    for (const vnet of vnets) {
      // Who built it matters more than it looks: a Flui-built network belongs
      // to one cluster and carries its traffic over an encrypted mesh, while a
      // provider-built one is shared and addressed by the provider.
      const builtBy =
        vnet.implementation === 'wireguard'
          ? chalk.cyan('built by Flui')
          : chalk.dim(vnet.provider);
      console.log(
        `  ${chalk.bold(vnet.name)}  ${vnet.ipRange}  ${builtBy}  ${chalk.dim(vnet.status)}`,
      );
      console.log(`  ${chalk.dim(vnet.id)}`);
      for (const subnet of vnet.subnets ?? []) {
        console.log(
          `    └ ${subnet.ipRange}  ${chalk.dim(subnet.networkZone ?? '')}  ${chalk.dim(subnet.id)}`,
        );
      }
      console.log('');
    }
    console.log(
      chalk.dim(
        '  Attach a new cluster with `flui cluster create <name> --vnet <id>`,\n' +
          '  or have Flui build one with `--flui-network`.\n',
      ),
    );
  }
}
