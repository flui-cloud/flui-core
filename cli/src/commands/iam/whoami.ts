import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { visitorSessionOf } from '../../lib/visitor-session';

interface MePermissions {
  permissions: string[];
  isAdmin: boolean;
}

export default class IamWhoami extends Command {
  static readonly description =
    'Show the effective permissions of the currently authenticated identity.';

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
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamWhoami);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let me: MePermissions;
    try {
      me = await api.get<MePermissions>('/me/permissions');
    } catch (error: unknown) {
      this.error(`Failed to load permissions: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    const visit = visitorSessionOf(configStorage);

    if (flags.output === 'json') {
      console.log(
        JSON.stringify(
          { ...me, visitor: !!visit, visitEnds: visit?.until ?? null },
          null,
          2,
        ),
      );
      return;
    }

    console.log('');
    if (visit) {
      const ends = visit.until
        ? `, until ${new Date(visit.until).toLocaleString()}`
        : '';
      console.log(
        `  ${chalk.yellow('●')} Visitor: looking around read-only${ends}. Sign in to deploy: ${chalk.cyan('flui login')}`,
      );
    }
    if (me.isAdmin) {
      console.log(`  ${chalk.green('●')} Admin — all permissions granted.`);
    }
    console.log(
      `  ${chalk.bold(`${me.permissions.length} permission${me.permissions.length === 1 ? '' : 's'}`)}:`,
    );
    for (const p of me.permissions) {
      console.log(`    ${chalk.cyan(p)}`);
    }
    if (me.permissions.length === 0) {
      console.log(chalk.dim('    (none)'));
    }
    console.log('');
  }
}
