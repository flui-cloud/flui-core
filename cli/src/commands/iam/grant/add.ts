import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

interface IamSelector {
  slugs?: string[];
  type?: 'system' | 'user';
  kind?: string;
  clusterId?: string;
  clusterName?: string;
  provider?: string;
  project?: string;
  tags?: string[];
}

interface CreateGrantBody {
  principalType: string;
  principalRef: string;
  role: string;
  scopeType: string;
  scopeRef?: string;
  selector?: IamSelector;
}

export default class IamGrantAdd extends Command {
  static readonly description =
    'Create an access grant: bind a principal to a role at a scope. ' +
    'Scope is one of everything (global), a cluster, a portal section, or a selector ' +
    'over app attributes (kind/project/provider/tags/slugs — AND-ed; tags match ALL).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> -p alice@acme.com -r manager',
    '<%= config.bin %> <%= command.id %> -t group -p platform -r viewer -s cluster --cluster c1',
    '<%= config.bin %> <%= command.id %> -p bob@acme.com -r editor -s selector --kind DATABASE',
    '<%= config.bin %> <%= command.id %> -p ci-deployer -t service_account -r editor -s selector --app acme-api --app acme-web',
  ];

  static readonly flags = {
    type: Flags.string({
      char: 't',
      description: 'Principal type',
      options: ['user', 'group', 'service_account'],
      default: 'user',
    }),
    principal: Flags.string({
      char: 'p',
      description:
        'Principal reference (email, group name, or service-account id)',
      required: true,
    }),
    role: Flags.string({
      char: 'r',
      description: 'Role to grant',
      options: ['viewer', 'editor', 'manager'],
      required: true,
    }),
    scope: Flags.string({
      char: 's',
      description: 'Scope type',
      options: ['global', 'cluster', 'section', 'selector'],
      default: 'global',
    }),
    cluster: Flags.string({ description: 'Cluster id (scope=cluster)' }),
    section: Flags.string({
      description: 'Portal section key (scope=section)',
    }),
    // selector fields (scope=selector); single-value = equality, list = membership
    kind: Flags.string({
      description: 'App kind, e.g. DATABASE (scope=selector)',
    }),
    project: Flags.string({ description: 'Project (scope=selector)' }),
    provider: Flags.string({ description: 'Provider (scope=selector)' }),
    'cluster-id': Flags.string({ description: 'Cluster id (scope=selector)' }),
    'cluster-name': Flags.string({
      description: 'Cluster name (scope=selector)',
    }),
    'app-type': Flags.string({
      description: 'App type (scope=selector)',
      options: ['system', 'user'],
    }),
    app: Flags.string({
      description: 'App slug — repeatable (scope=selector)',
      multiple: true,
    }),
    tag: Flags.string({
      description: 'Tag — repeatable, app must carry ALL (scope=selector)',
      multiple: true,
    }),
    selector: Flags.string({
      description: 'Raw selector JSON (overrides individual selector flags)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamGrantAdd);

    const body: CreateGrantBody = {
      principalType: flags.type,
      principalRef: flags.principal,
      role: flags.role,
      scopeType: flags.scope,
    };

    if (flags.scope === 'cluster') {
      if (!flags.cluster) {
        this.error('scope=cluster requires --cluster <id>.', { exit: 1 });
      }
      body.scopeRef = flags.cluster;
    } else if (flags.scope === 'section') {
      if (!flags.section) {
        this.error('scope=section requires --section <key>.', { exit: 1 });
      }
      body.scopeRef = flags.section;
    } else if (flags.scope === 'selector') {
      body.selector = this.buildSelector(flags);
    }

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.', { exit: 1 });
    }
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let created: { id: string };
    try {
      created = await api.post<{ id: string }>('/iam/grants', body);
    } catch (error: unknown) {
      this.error(`Failed to create grant: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(created, null, 2));
      return;
    }

    console.log(
      `\n  ${chalk.green('✓')} Granted ${chalk.bold(flags.role)} to ${chalk.bold(`${flags.type}:${flags.principal}`)} ${chalk.dim(`(${created.id})`)}\n`,
    );
  }

  private buildSelector(flags: {
    selector?: string;
    kind?: string;
    project?: string;
    provider?: string;
    'cluster-id'?: string;
    'cluster-name'?: string;
    'app-type'?: string;
    app?: string[];
    tag?: string[];
  }): IamSelector {
    if (flags.selector) {
      try {
        return JSON.parse(flags.selector) as IamSelector;
      } catch {
        this.error('--selector must be valid JSON.', { exit: 1 });
      }
    }

    const selector: IamSelector = {};
    if (flags.kind) selector.kind = flags.kind;
    if (flags.project) selector.project = flags.project;
    if (flags.provider) selector.provider = flags.provider;
    if (flags['cluster-id']) selector.clusterId = flags['cluster-id'];
    if (flags['cluster-name']) selector.clusterName = flags['cluster-name'];
    if (flags['app-type'])
      selector.type = flags['app-type'] as 'system' | 'user';
    if (flags.app?.length) selector.slugs = flags.app;
    if (flags.tag?.length) selector.tags = flags.tag;

    if (Object.keys(selector).length === 0) {
      this.error(
        'scope=selector requires at least one selector flag ' +
          '(--kind/--project/--provider/--cluster-id/--cluster-name/--app-type/--app/--tag) or --selector JSON.',
        { exit: 1 },
      );
    }
    return selector;
  }
}
