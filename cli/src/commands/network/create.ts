import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface CreatedVNet {
  id: string;
  name: string;
  ipRange: string;
  subnets?: Array<{ id: string; ipRange: string; networkZone?: string }>;
}

interface ProviderDefinition {
  capabilities?: {
    vnetTopology?: {
      zones?: Array<{
        id: string;
        displayName?: string;
        coveredRegions?: string[];
      }>;
    } | null;
  };
}

/**
 * The missing half of `network list`.
 *
 * A provider that declares `vnetRequired` cannot have a cluster created on it
 * until one of its networks exists, and until now the only way to make one was
 * the dashboard — which left the whole cross-provider path unreachable from a
 * terminal.
 */
export default class NetworkCreate extends Command {
  static readonly description =
    'Create a private network on a provider, with its first subnet. Needed ' +
    'before a cluster can be created on a provider that requires one.';

  static readonly summary = 'Create a private network';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --provider ovh --zone GRA',
    '<%= config.bin %> <%= command.id %> --provider hetzner --zone eu-central --ip-range 10.60.0.0/16',
  ];

  static readonly flags = {
    provider: Flags.string({
      description: 'Provider to create the network on',
      required: true,
    }),
    zone: Flags.string({
      description:
        'Network zone. Omit to use the provider’s only zone, or to be shown the choices.',
    }),
    'ip-range': Flags.string({
      description: 'CIDR for the network. Defaults to 10.60.0.0/16.',
      default: '10.60.0.0/16',
    }),
    'subnet-range': Flags.string({
      description:
        'CIDR for the first subnet. Defaults to the whole network range.',
    }),
    name: Flags.string({
      description: 'Name for the network. Defaults to <provider>-<zone>.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(NetworkCreate);

    const configStorage = new ConfigStorage();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const apiClient = new ApiClient({
      baseUrl: configStorage.getApiUrlOrThrow(),
      apiKey,
    });

    const zone = await this.resolveZone(apiClient, flags.provider, flags.zone);
    const name = flags.name ?? `${flags.provider}-${zone}`.toLowerCase();

    console.log('');
    console.log(`  ${chalk.bold('Provider:')}  ${flags.provider}`);
    console.log(`  ${chalk.bold('Zone:')}      ${zone}`);
    console.log(`  ${chalk.bold('Range:')}     ${flags['ip-range']}`);
    console.log(`  ${chalk.bold('Name:')}      ${name}`);
    console.log('');

    const spinner = ora('Creating the network...').start();
    try {
      const vnet = await apiClient.post<CreatedVNet>('/vnets', {
        name,
        provider: flags.provider,
        ipRange: flags['ip-range'],
        subnets: [
          {
            networkZone: zone,
            // The provider allocates one inside the network when this is
            // omitted; passing the whole range is only right where subnets and
            // networks share a prefix.
            ...(flags['subnet-range']
              ? { ipRange: flags['subnet-range'] }
              : {}),
          },
        ],
      });
      spinner.succeed(`Network created (${vnet.ipRange})`);
      console.log('');
      console.log(`  ${chalk.bold('VNet ID:')}   ${vnet.id}`);
      for (const subnet of vnet.subnets ?? []) {
        console.log(
          `  ${chalk.bold('Subnet:')}    ${subnet.ipRange}  ${chalk.dim(subnet.id)}`,
        );
      }
      console.log('');
      console.log(
        chalk.dim(
          `  Create a cluster on it with:\n` +
            `    flui cluster create <name> --provider ${flags.provider} --vnet ${vnet.id}\n`,
        ),
      );
    } catch (error: any) {
      spinner.fail('Not created');
      console.log(
        chalk.red(`\n  ${error.response?.data?.message ?? error.message}\n`),
      );
      this.exit(1);
    }
  }

  /**
   * A zone is not optional to the provider, only to the person: every provider
   * here is regional, so the network exists in one place and a cluster in
   * another region cannot join it.
   */
  private async resolveZone(
    apiClient: ApiClient,
    provider: string,
    given?: string,
  ): Promise<string> {
    if (given) return given;

    const definition = await apiClient
      .get<ProviderDefinition>(
        `/management/providers/${encodeURIComponent(provider)}`,
      )
      .catch(() => null);
    const zones = definition?.capabilities?.vnetTopology?.zones ?? [];

    if (zones.length === 1) return zones[0].id;
    if (zones.length === 0) {
      this.error(
        `No network zone given, and ${provider} does not publish its zones — ` +
          `pass --zone with the region the network should live in.`,
        { exit: 1 },
      );
    }
    this.error(
      `This provider has more than one network zone; pass --zone with one of:\n` +
        zones
          .map(
            (z) =>
              `  • ${z.id}${z.coveredRegions?.length ? `  (${z.coveredRegions.join(', ')})` : ''}`,
          )
          .join('\n'),
      { exit: 1 },
    );
  }
}
