import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface ApiKeySummary {
  id: string;
  name: string;
  revoked: boolean;
  createdAt: string;
  expiresAt: string | null;
  scopes: string[] | null;
}

export default class AuthApiKeys extends Command {
  static readonly description =
    'List the API keys issued for the signed-in identity, with the scopes each one carries.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
    profile: Flags.string({
      description:
        'Profile to read the credential from (default: active profile)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthApiKeys);

    const storage = new ConfigStorage(flags.profile);
    const apiUrl = storage.getApiUrlOrThrow();
    const apiKey = storage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let keys: ApiKeySummary[];
    try {
      keys = await api.get<ApiKeySummary[]>('/auth/api-keys');
    } catch (error: unknown) {
      this.error(`Failed to list API keys: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(keys, null, 2));
      return;
    }

    if (keys.length === 0) {
      console.log(chalk.dim('\n  No API keys.\n'));
      return;
    }

    const nameW = Math.max(...keys.map((k) => k.name.length), 4);
    console.log('');
    console.log(
      `  ${chalk.bold('NAME'.padEnd(nameW))}  ${chalk.bold('STATE'.padEnd(8))}  ${chalk.bold('SCOPES')}`,
    );
    console.log(`  ${'─'.repeat(nameW)}  ${'─'.repeat(8)}  ${'─'.repeat(30)}`);
    for (const k of keys) {
      const word = state(k);
      const painted = STATE_PAINT[word](word.padEnd(8));
      console.log(
        `  ${k.name.padEnd(nameW)}  ${painted}  ${scopeList(k)}  ${chalk.dim(k.id)}`,
      );
    }
    console.log('');
    console.log(
      chalk.dim('  Revoke one with `flui auth revoke-api-key <id>`.\n'),
    );
  }
}

type KeyState = 'revoked' | 'expired' | 'active';

const STATE_PAINT: Record<KeyState, (s: string) => string> = {
  revoked: chalk.red,
  expired: chalk.yellow,
  active: chalk.green,
};

function expired(k: ApiKeySummary): boolean {
  return !!k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
}

function state(k: ApiKeySummary): KeyState {
  if (k.revoked) return 'revoked';
  if (expired(k)) return 'expired';
  return 'active';
}

function scopeList(k: ApiKeySummary): string {
  if (k.scopes?.length) return k.scopes.join(' ');
  return chalk.dim('(unscoped — the full weight of the issuer)');
}
