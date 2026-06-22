import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

interface IamSelector {
  slugs?: string[];
  type?: string;
  kind?: string;
  clusterId?: string;
  clusterName?: string;
  provider?: string;
  project?: string;
  tags?: string[];
}

interface IamGrant {
  id: string;
  principalType: string;
  principalRef: string;
  role: string;
  scopeType: 'global' | 'cluster' | 'section' | 'selector';
  scopeRef: string | null;
  selector: IamSelector | null;
}

export function describeScope(g: IamGrant): string {
  switch (g.scopeType) {
    case 'global':
      return 'everything';
    case 'cluster':
      return `cluster ${g.scopeRef ?? '?'}`;
    case 'section':
      return `section ${g.scopeRef ?? '?'}`;
    case 'selector':
      return describeSelector(g.selector ?? {});
  }
}

function describeSelector(s: IamSelector): string {
  const parts: string[] = [];
  if (s.slugs?.length) parts.push(`apps[${s.slugs.join(',')}]`);
  if (s.kind) parts.push(`kind=${s.kind}`);
  if (s.type) parts.push(`type=${s.type}`);
  if (s.project) parts.push(`project=${s.project}`);
  if (s.provider) parts.push(`provider=${s.provider}`);
  if (s.clusterId) parts.push(`clusterId=${s.clusterId}`);
  if (s.clusterName) parts.push(`clusterName=${s.clusterName}`);
  if (s.tags?.length) parts.push(`tags⊇[${s.tags.join(',')}]`);
  return parts.length ? parts.join(' ') : 'selector';
}

export default class IamGrantList extends Command {
  static readonly description = 'List access grants (role bindings).';

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
    const { flags } = await this.parse(IamGrantList);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let grants: IamGrant[];
    try {
      grants = await api.get<IamGrant[]>('/iam/grants');
    } catch (error: unknown) {
      this.error(`Failed to list grants: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(grants, null, 2));
      return;
    }

    if (grants.length === 0) {
      console.log(chalk.dim('\n  No grants yet.'));
      console.log(chalk.dim('  Create one with `flui iam grant add`.\n'));
      return;
    }

    const whoW = Math.max(
      ...grants.map((g) => `${g.principalType}:${g.principalRef}`.length),
      3,
    );
    const roleW = Math.max(...grants.map((g) => g.role.length), 4);

    console.log('');
    console.log(
      `  ${chalk.bold('WHO'.padEnd(whoW))}  ${chalk.bold('ROLE'.padEnd(roleW))}  ${chalk.bold('ON')}`,
    );
    console.log(
      `  ${'─'.repeat(whoW)}  ${'─'.repeat(roleW)}  ${'─'.repeat(20)}`,
    );
    for (const g of grants) {
      const who = `${g.principalType}:${g.principalRef}`;
      console.log(
        `  ${who.padEnd(whoW)}  ${g.role.padEnd(roleW)}  ${describeScope(g)}  ${chalk.dim(g.id)}`,
      );
    }
    console.log('');
  }
}
