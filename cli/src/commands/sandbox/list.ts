import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SandboxClient, SandboxTenancy } from '../../lib/sandbox-client';
import { printContextBanner } from '../../lib/context-banner';

export function colorState(state: string): string {
  switch (state) {
    case 'ready':
      return chalk.green(state);
    case 'claimed':
      return chalk.cyan(state);
    case 'needs_attention':
      return chalk.red(state);
    case 'failed':
      return chalk.yellow(state);
    default:
      return chalk.dim(state);
  }
}

function span(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 2880) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function when(iso?: string | null): string {
  if (!iso) return chalk.dim('—');
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return chalk.dim(String(iso));
  const minutes = Math.round((then - Date.now()) / 60000);
  const ago = minutes < 0;
  const n = Math.abs(minutes);
  const text = span(n);
  return chalk.dim(ago ? `${text} ago` : `in ${text}`);
}

export default class SandboxList extends Command {
  static readonly description = 'Guest areas this instance is holding';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --stuck',
  ];
  static readonly flags = {
    stuck: Flags.boolean({
      default: false,
      description: 'Only the areas that stopped being retried',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SandboxList);
    printContextBanner();

    const all = await SandboxClient.fromConfig().listTenancies();
    const rows: SandboxTenancy[] = flags.stuck
      ? all.filter((t) => t.state === 'needs_attention' || t.state === 'failed')
      : all;

    if (flags.json) {
      this.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      this.log(chalk.yellow('\n   No guest areas.\n'));
      return;
    }

    this.log('');
    for (const t of rows) {
      const age =
        t.state === 'claimed'
          ? `expires ${when(t.expiresAt)}`
          : chalk.dim(`created ${when(t.createdAt)}`);
      this.log(
        `   ${chalk.bold(t.namespace.padEnd(28))} ${colorState(t.state).padEnd(24)} ${age}`,
      );
      if (t.lastError) {
        const tries =
          t.reapAttempts > 1 ? chalk.dim(` (×${t.reapAttempts})`) : '';
        this.log(`     ${chalk.red('why')}  ${t.lastError}${tries}`);
      }
    }

    const parked = rows.filter((t) => t.state === 'needs_attention').length;
    this.log(
      parked > 0
        ? chalk.dim(
            `\n   ${parked} stopped being retried · flui sandbox expire <namespace>\n`,
          )
        : '\n',
    );
  }
}
