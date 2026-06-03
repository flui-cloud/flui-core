import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService, AppGroup } from '../../lib/services/cli-app.service';
import { resolveCluster } from '../../lib/resolve-cluster';

export default class AppList extends Command {
  static readonly description = 'List all applications in the cluster';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --expanded',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    expanded: Flags.boolean({
      char: 'x',
      description: 'Show the individual components of composed apps',
      default: false,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AppList);
    const spinner = ora('Fetching applications...').start();

    try {
      const { id: clusterId } = await resolveCluster(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const groups = await service.listAppGroups();

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(groups, null, 2));
        return;
      }

      if (groups.length === 0) {
        console.log(
          chalk.yellow('\n  No applications found in this cluster.\n'),
        );
        return;
      }

      console.log(chalk.cyan('\n  Applications\n'));
      console.log(
        chalk.dim(
          `  ${'NAME'.padEnd(30)} ${'STATUS'.padEnd(14)} ${'REPLICAS'.padEnd(10)} ${'KIND'.padEnd(12)} ${'EXPOSURE'.padEnd(10)} LAST DEPLOY`,
        ),
      );
      console.log(chalk.dim('  ' + '─'.repeat(92)));

      for (const group of groups) {
        this.printGroup(group, flags.expanded);
      }

      const appCount = groups.reduce((n, g) => n + g.componentCount, 0);
      const composed = groups.filter((g) => g.type === 'composed').length;
      console.log('');
      console.log(
        chalk.dim(
          `  ${groups.length} app${groups.length === 1 ? '' : 's'}` +
            (composed > 0 ? ` (${appCount} components)` : '') +
            (composed > 0 && !flags.expanded
              ? chalk.dim(' · use --expanded to list components')
              : ''),
        ),
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch applications');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private printGroup(group: AppGroup, expanded: boolean): void {
    if (group.type === 'standalone') {
      const app = group.components[0];
      this.printRow({
        name: group.name,
        status: group.status,
        replicas: String(app?.replicas ?? '-'),
        kind: (app?.kind || '').toLowerCase(),
        exposure: (app?.exposure || '').toLowerCase(),
        lastDeploy: app?.lastDeployedAt,
      });
      return;
    }

    const marker = expanded ? '▾' : '▸';
    const primary = group.components.find((c) => c.isPrimary);
    this.printRow({
      name: `${marker} ${group.name} (${group.componentCount})`,
      status: group.status,
      replicas: '-',
      kind: 'composed',
      exposure: (primary?.exposure || '').toLowerCase(),
      lastDeploy: undefined,
    });

    if (!expanded) return;
    const children = [...group.components].sort(
      (a, b) => Number(b.isPrimary ?? false) - Number(a.isPrimary ?? false),
    );
    children.forEach((c, i) => {
      const branch = i === children.length - 1 ? '└' : '├';
      const short = c.slug.startsWith(`${group.slug}-`)
        ? c.slug.slice(group.slug.length + 1)
        : c.slug;
      this.printRow({
        name: `    ${branch} ${short}${c.isPrimary ? chalk.dim(' (primary)') : ''}`,
        status: c.status,
        replicas: String(c.replicas ?? '-'),
        kind: (c.kind || '').toLowerCase(),
        exposure: (c.exposure || '').toLowerCase(),
        lastDeploy: c.lastDeployedAt,
        dim: true,
      });
    });
  }

  private printRow(r: {
    name: string;
    status: string;
    replicas: string;
    kind: string;
    exposure: string;
    lastDeploy?: string;
    dim?: boolean;
  }): void {
    const visibleLen = r.name.replace(/\x1b\[[0-9;]*m/g, '').length;
    const namePad = r.name + ' '.repeat(Math.max(0, 30 - visibleLen));
    const status = this.colorStatus(r.status.padEnd(14));
    const last = r.lastDeploy
      ? new Date(r.lastDeploy).toLocaleString()
      : chalk.dim('—');
    const line = `  ${namePad} ${status} ${r.replicas.padEnd(10)} ${r.kind.padEnd(12)} ${r.exposure.padEnd(10)} ${last}`;
    console.log(r.dim ? chalk.dim(line) : line);
  }

  private colorStatus(status: string): string {
    const s = status.trim().toLowerCase();
    if (s === 'running') return chalk.green(status);
    if (s === 'stopped') return chalk.yellow(status);
    if (s === 'failed' || s === 'degraded') return chalk.red(status);
    if (s === 'provisioning' || s === 'updating') return chalk.blue(status);
    return chalk.dim(status);
  }
}
