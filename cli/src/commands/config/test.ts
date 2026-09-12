import { Command, Args } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { ProviderFactory } from 'src/modules/providers/core/factories/provider.factory';
import { ICloudProvider } from 'src/modules/providers/interfaces/cloud-provider.interface';
import { SUPPORTED_PROVIDERS } from '../../config/key-router';
import { CLOUD_PROVIDER_BY_KEY } from '../../config/provider-map';

function printList<T>(
  items: T[],
  emptyLabel: string,
  countLabel: string,
  describe: (item: T) => string,
): void {
  if (items.length === 0) {
    console.log(chalk.dim(`  ${emptyLabel}`));
    return;
  }
  console.log(chalk.yellow(`  ${items.length} ${countLabel} found:`));
  for (const item of items) {
    console.log(chalk.dim(`    - ${describe(item)}`));
  }
}

async function reportResources(provider: ICloudProvider): Promise<void> {
  if (provider.listServersAsDto) {
    const servers = await provider.listServersAsDto();
    printList(
      servers,
      'No servers found on this account.',
      'server(s)',
      (s) =>
        `${s.name} (${s.id}) ${s.status} @ ${s.location} — ${s.public_ip ?? 'no public IP'}`,
    );
  }

  if (provider.listFluiManagedVolumes) {
    const volumes = await provider.listFluiManagedVolumes();
    printList(
      volumes,
      'No Flui-managed volumes found.',
      'volume(s)',
      (v) => `${v.name} (${v.volumeId}) ${v.sizeGb}GB @ ${v.region ?? '?'}`,
    );
  }

  if (provider.listVNets) {
    const vnets = await provider.listVNets();
    printList(
      vnets,
      'No VNets found on this account.',
      'VNet(s)',
      (v) =>
        `${v.name} (${v.id}) ${v.ipRange} — ${v.subnets.length} subnet(s), ${v.attachedServerIds.length} attached server(s)`,
    );
  }
}

export default class ConfigTest extends Command {
  static readonly description =
    'Test the stored credentials for a provider with a real, read-only API call — no resources are created or changed.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> ovh',
    '<%= config.bin %> <%= command.id %> hetzner',
  ];

  static readonly args = {
    provider: Args.string({
      required: true,
      description: 'Provider to test',
      options: [...SUPPORTED_PROVIDERS],
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigTest);
    const cloudProvider = CLOUD_PROVIDER_BY_KEY[args.provider];

    const spinner = ora(`Testing ${args.provider} credentials...`).start();
    try {
      const app = await getNestApp();
      const providerFactory = app.get(ProviderFactory);
      const provider = providerFactory.getProvider(cloudProvider);
      const result = await provider.testConnection();

      if (result.success) {
        spinner.succeed(`${args.provider} credentials are valid`);
      } else {
        spinner.fail(
          `${args.provider} credentials failed: ${result.error ?? 'unknown error'}`,
        );
        this.exit(1);
      }

      await reportResources(provider);
    } catch (error: any) {
      spinner.fail(`${args.provider} test failed: ${error.message}`);
      console.log(
        chalk.dim(
          `\n   Configure credentials first: flui config set ${args.provider}\n`,
        ),
      );
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
