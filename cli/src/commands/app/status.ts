import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../lib/resolve-cluster';

export default class AppStatus extends Command {
  static readonly description = 'Show live runtime status of an application';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-api',
    '<%= config.bin %> <%= command.id %> my-api --output json',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppStatus);
    const spinner = ora(`Fetching status for "${args.name}"...`).start();

    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const [runtime, endpoints] = await Promise.all([
        service.getRuntime(app.id),
        service.listEndpoints(app.id).catch(() => []),
      ]);

      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify({ app, runtime, endpoints }, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  ${app.name}\n`));
      console.log(`  ${chalk.bold('ID:')}         ${app.id}`);
      console.log(
        `  ${chalk.bold('Status:')}     ${this.colorStatus(app.status)}`,
      );
      console.log(
        `  ${chalk.bold('Kind:')}       ${(app.kind || '').toLowerCase()}`,
      );
      console.log(
        `  ${chalk.bold('Exposure:')}   ${(app.exposure || '').toLowerCase()}`,
      );
      if (app.lastDeployedAt) {
        console.log(
          `  ${chalk.bold('Deployed:')}   ${new Date(app.lastDeployedAt).toLocaleString()}`,
        );
      }

      console.log(chalk.cyan('\n  Replicas\n'));
      const r = runtime.replicas;
      const ready = r.ready ?? 0;
      const desired = r.desired ?? 0;
      const replicaColor =
        ready === desired && desired > 0 ? chalk.green : chalk.yellow;
      console.log(`  ${chalk.bold('Desired:')}    ${desired}`);
      console.log(
        `  ${chalk.bold('Ready:')}      ${replicaColor(String(ready))}`,
      );
      if (r.unavailable) {
        console.log(
          `  ${chalk.bold('Unavailable:')} ${chalk.red(String(r.unavailable))}`,
        );
      }

      if (runtime.containers.length > 0) {
        console.log(chalk.cyan('\n  Containers\n'));
        for (const c of runtime.containers) this.printContainer(c);
      }

      if (endpoints.length > 0) {
        console.log(chalk.cyan('\n  Endpoints\n'));
        for (const e of endpoints) this.printEndpoint(e);
      }

      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to fetch status');
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }

  private printEndpoint(e: {
    fqdn: string;
    tlsEnabled: boolean;
    endpointType: string;
    hostnameMode: string;
    certificateStatus?: string;
    certificateMessage?: string;
    reconciliationStatus?: string;
  }): void {
    const scheme = e.tlsEnabled ? 'https' : 'http';
    const url = `${scheme}://${e.fqdn}`;
    console.log(`  ${chalk.bold('URL:')}        ${chalk.cyan(url)}`);
    const meta = [
      e.endpointType,
      e.hostnameMode,
      e.tlsEnabled ? 'tls' : 'no-tls',
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`  ${chalk.dim(meta)}`);
    if (e.certificateStatus && e.certificateStatus !== 'ISSUED') {
      const color = e.certificateStatus === 'FAILED' ? chalk.red : chalk.yellow;
      console.log(
        `  ${chalk.bold('Cert:')}       ${color(e.certificateStatus)}${
          e.certificateMessage ? ` — ${e.certificateMessage}` : ''
        }`,
      );
    }
  }

  private printContainer(c: any): void {
    console.log(`  ${chalk.bold(c.name)}`);
    console.log(`    ${chalk.dim('image:')}   ${c.image}`);
    const req = c.requests;
    const lim = c.limits;
    if (req.cpu || req.memory) {
      console.log(
        `    ${chalk.dim('requests:')} cpu=${req.cpu ?? '-'}  mem=${req.memory ?? '-'}`,
      );
    }
    if (lim.cpu || lim.memory) {
      console.log(
        `    ${chalk.dim('limits:')}   cpu=${lim.cpu ?? '-'}  mem=${lim.memory ?? '-'}`,
      );
    }
    if (c.usage) {
      const u = c.usage;
      console.log(
        `    ${chalk.dim('usage:')}    cpu=${u.cpu ?? '-'}  mem=${u.memory ?? '-'}`,
      );
    }
  }

  private colorStatus(status: string): string {
    const s = status.toLowerCase();
    if (s === 'running') return chalk.green(status);
    if (s === 'stopped') return chalk.yellow(status);
    if (s === 'failed' || s === 'degraded') return chalk.red(status);
    if (s === 'provisioning' || s === 'updating') return chalk.blue(status);
    return chalk.dim(status);
  }
}
