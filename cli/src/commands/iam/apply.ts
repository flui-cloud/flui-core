import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import * as fs from 'node:fs';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

// js-yaml ships no bundled types here; the shape we use is tiny and stable.
const yaml = require('js-yaml') as { load: (s: string) => unknown };

interface ApplyResult {
  created: number;
  unchanged: number;
  deleted: number;
  desired: number;
}

export default class IamApply extends Command {
  static readonly description =
    'Apply an AccessPolicy file (idempotent upsert of grants; --prune for full sync).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> -f access-policy.yaml',
    '<%= config.bin %> <%= command.id %> -f access-policy.yaml --prune',
  ];

  static readonly flags = {
    file: Flags.string({
      char: 'f',
      description: 'Path to the AccessPolicy YAML/JSON file',
      required: true,
    }),
    prune: Flags.boolean({
      description:
        'Delete existing grants not present in the file (full sync). Off by default.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamApply);

    let raw: string;
    try {
      raw = fs.readFileSync(flags.file, 'utf8');
    } catch (error: unknown) {
      this.error(`Cannot read ${flags.file}: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    let doc: Record<string, unknown>;
    try {
      doc = yaml.load(raw) as Record<string, unknown>;
    } catch (error: unknown) {
      this.error(`Invalid YAML/JSON: ${(error as Error).message}`, { exit: 1 });
    }
    if (!doc || doc['kind'] !== 'AccessPolicy') {
      this.error(
        'Not an AccessPolicy document (expected `kind: AccessPolicy`).',
        { exit: 1 },
      );
    }
    doc['prune'] = flags.prune;

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let result: ApplyResult;
    try {
      result = await api.post<ApplyResult>('/iam/apply', doc);
    } catch (error: unknown) {
      this.error(`Apply failed: ${(error as Error).message}`, { exit: 1 });
    }

    console.log('');
    console.log(`  ${chalk.green('✔')} Applied ${chalk.bold(flags.file)}`);
    console.log(`    created:   ${chalk.bold(result.created)}`);
    console.log(`    unchanged: ${chalk.bold(result.unchanged)}`);
    if (flags.prune) {
      console.log(`    deleted:   ${chalk.bold(result.deleted)}`);
    }
    console.log('');
  }
}
