import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import {
  InstallLogChunk,
  followInstallLog,
} from '../../lib/install-log-follow';

export default class NodeLogs extends Command {
  static readonly description =
    "Print the install log of a node an operation is creating — a new cluster's first node, or a single added node — and with --follow keep printing new lines until the operation ends. The operation id comes from the command that added the node, `flui operation`, or `flui scaling why`.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 9e5b17a1-730d-460b-9842-69320435b6e0',
    '<%= config.bin %> <%= command.id %> 9e5b17a1-... --follow',
  ];

  static readonly args = {
    operation: Args.string({
      description: 'ID of the operation that creates the node',
      required: true,
    }),
  };

  static readonly flags = {
    follow: Flags.boolean({
      char: 'f',
      description:
        'Keep printing new lines as the node writes them, until the operation has finished',
      default: false,
    }),
    interval: Flags.integer({
      description: 'Seconds between reads while following',
      default: 3,
      min: 1,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(NodeLogs);
    const storage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: storage.getApiUrlOrThrow(),
      apiKey: storage.getApiKeyOrThrow(),
    });
    const path = `/infrastructure/operations/${encodeURIComponent(args.operation)}/log/chunk`;

    let last: InstallLogChunk;
    try {
      last = await followInstallLog({
        read: (since) =>
          api.get<InstallLogChunk>(`${path}?since=${since}`, {
            timeoutMs: 15000,
          }),
        write: (text) => process.stdout.write(text),
        follow: flags.follow,
        intervalMs: flags.interval * 1000,
      });
    } catch (error: any) {
      const message = error?.response?.data?.message ?? error?.message;
      process.stderr.write(chalk.red(`\n  Error: ${message}\n`));
      this.exit(1);
    }

    if (last.note) process.stderr.write(chalk.yellow(`\n  ${last.note}\n`));
    if (flags.follow) {
      process.stderr.write(`\n  Operation ${outcomeLabel(last.status)}.\n`);
      if (last.status === 'FAILED') this.exit(1);
    } else if (!last.done && last.captured) {
      process.stderr.write(
        chalk.dim('\n  Still installing: add --follow to keep reading.\n'),
      );
    }
  }
}

function outcomeLabel(status: string): string {
  if (status === 'COMPLETED') return chalk.green('completed');
  if (status === 'FAILED') return chalk.red('failed');
  return chalk.yellow(status.toLowerCase());
}
