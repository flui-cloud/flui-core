import { Command, Flags } from '@oclif/core';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import {
  RegistryModeStatus,
  registryModeLines,
} from '../../lib/registry-mode-view';

export function printRegistryMode(status: RegistryModeStatus): void {
  console.log('');
  for (const line of registryModeLines(status)) console.log(`  ${line}`);
  console.log('');
}

export default class RegistryStatus extends Command {
  static readonly description =
    'Show where new builds push their images: GitHub Container Registry or the Flui registry, where it keeps them and whether it is ready.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = {
    json: Flags.boolean({ description: 'Print the raw status as JSON' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RegistryStatus);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });
    const status = await api.get<RegistryModeStatus>('/registry/mode');
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    printRegistryMode(status);
  }
}
