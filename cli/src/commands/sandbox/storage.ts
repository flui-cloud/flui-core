import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { printContextBanner } from '../../lib/context-banner';

interface TenancyQuota {
  namespace: string;
  projectId: number;
  usedBytes: number;
  limitBytes: number;
}

interface NodeQuota {
  node: string;
  supported: boolean;
  reason?: string;
  tenancies: TenancyQuota[];
}

interface Reconciliation {
  reconciledAt: string;
  nodes: NodeQuota[];
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function bar(used: number, limit: number): string {
  if (limit <= 0) return '';
  const filled = Math.min(20, Math.round((used / limit) * 20));
  const shade = used / limit > 0.9 ? chalk.red : chalk.green;
  return `${shade('█'.repeat(filled))}${chalk.dim('░'.repeat(20 - filled))}`;
}

export default class SandboxStorage extends Command {
  static readonly description =
    "Apply the guests' storage ceilings now, and show what each area is using";

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SandboxStorage);
    printContextBanner();
    const spinner = ora('Applying ceilings and reading them back...').start();

    try {
      const { api } = await openControlPlane(await getNestApp());
      // It runs a short job on every node and waits for all of them, so the
      // default 30s client timeout reports a working call as an unreachable
      // server. The ceiling is the server's own per-node timeout, not this.
      const result = await api.post<Reconciliation>(
        '/sandbox/storage-ceilings',
        {},
        { timeoutMs: 300_000 },
      );
      spinner.stop();

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2));
        return;
      }
      this.render(result);
    } catch (error) {
      spinner.fail('Could not apply the ceilings');
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private render(result: Reconciliation): void {
    if (result.nodes.length === 0) {
      this.log('');
      this.log(
        chalk.dim('   No guest areas are live, so there is nothing to cap.\n'),
      );
      return;
    }

    for (const node of result.nodes) {
      this.log('');
      this.log(`   ${chalk.bold(node.node)}`);

      // The honest half. A node whose storage cannot enforce a quota is a
      // normal state, and saying so is the difference between "no guest is over" and "nobody is checking".
      if (!node.supported) {
        this.log(
          `     ${chalk.yellow('no ceiling in force')} ${chalk.dim(
            `— ${node.reason ?? 'this storage cannot enforce one'}`,
          )}`,
        );
        continue;
      }

      if (node.tenancies.length === 0) {
        this.log(chalk.dim('     ceilings in force, nothing written yet'));
        continue;
      }

      for (const t of node.tenancies) {
        const pct = t.limitBytes > 0 ? (t.usedBytes / t.limitBytes) * 100 : 0;
        this.log(
          `     ${t.namespace.padEnd(24)} ${bar(t.usedBytes, t.limitBytes)} ` +
            `${bytes(t.usedBytes).padStart(9)} / ${bytes(t.limitBytes)}` +
            chalk.dim(`  (${pct.toFixed(0)}%)`),
        );
      }
    }
    this.log('');
  }
}
