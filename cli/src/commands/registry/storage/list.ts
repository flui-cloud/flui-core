import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

export interface RegistryBucket {
  id: string;
  provider: string;
  region: string;
  bucket: string;
  active: boolean;
  createdByFlui: boolean;
  connectedAt: string;
}

export default class RegistryStorageList extends Command {
  static readonly description =
    'List the buckets the image registry has been connected to: the one in use and the ones it replaced.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ description: 'Print the raw list as JSON' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RegistryStorageList);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });
    const buckets = await api.get<RegistryBucket[]>(
      '/registry/storage/buckets',
    );
    if (flags.json) {
      console.log(JSON.stringify(buckets, null, 2));
      return;
    }
    if (buckets.length === 0) {
      console.log(chalk.dim('\n  No bucket connected.\n'));
      return;
    }
    console.log('');
    for (const b of buckets) {
      const state = b.active ? chalk.green('in use') : chalk.dim('replaced');
      const origin = b.createdByFlui ? 'created by Flui' : 'your own';
      console.log(`  ${chalk.bold(b.bucket)}  ${state}`);
      console.log(
        chalk.dim(
          `    ${b.id}  ${b.provider} ${b.region}, ${origin}, connected ${new Date(b.connectedAt).toLocaleString()}`,
        ),
      );
    }
    if (buckets.some((b) => !b.active)) {
      console.log(
        chalk.dim(
          '\n  Remove a replaced bucket with `flui registry storage remove <id>`.',
        ),
      );
    }
    console.log('');
  }
}
