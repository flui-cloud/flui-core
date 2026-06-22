import { Command, Flags } from '@oclif/core';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

// js-yaml ships no bundled types here; the shape we use is tiny and stable.
const yaml = require('js-yaml') as { dump: (o: unknown) => string };

export default class IamExport extends Command {
  static readonly description =
    'Export all access grants as a kind: AccessPolicy document (config-as-code snapshot). YAML by default.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> > access-policy.yaml',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['yaml', 'json'],
      default: 'yaml',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamExport);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let doc: unknown;
    try {
      doc = await api.get('/iam/policy');
    } catch (error: unknown) {
      this.error(`Failed to export policy: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(doc, null, 2));
      return;
    }
    process.stdout.write(yaml.dump(doc));
  }
}
