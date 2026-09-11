import { Command, Args } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { ProviderFactory } from 'src/modules/providers/core/factories/provider.factory';
import { SUPPORTED_PROVIDERS } from '../../config/key-router';
import { CLOUD_PROVIDER_BY_KEY } from '../../config/provider-map';

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
    let app: any;
    try {
      app = await getNestApp();
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

      if (provider.listServersAsDto) {
        const servers = await provider.listServersAsDto();
        if (servers.length === 0) {
          console.log(chalk.dim('  No servers found on this account.'));
        } else {
          console.log(chalk.yellow(`  ${servers.length} server(s) found:`));
          for (const s of servers) {
            console.log(
              chalk.dim(
                `    - ${s.name} (${s.id}) ${s.status} @ ${s.location} — ${s.public_ip ?? 'no public IP'}`,
              ),
            );
          }
        }
      }
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
