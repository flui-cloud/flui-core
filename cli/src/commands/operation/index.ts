import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface Operation {
  id: string;
  operationType: string | null;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  resourceName: string | null;
  progress: number;
  metadata?: { message?: string } | null;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

const DONE = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const POLL_MS = 5000;

export default class OperationShow extends Command {
  static readonly description =
    'Show an infrastructure operation — a node being added or removed, a cluster being created — and follow it to the end. `flui scaling why` names the operation a scaling decision started.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 9e5b17a1-730d-460b-9842-69320435b6e0',
    '<%= config.bin %> <%= command.id %> 9e5b17a1-... --follow',
    '<%= config.bin %> <%= command.id %> 9e5b17a1-... --log',
  ];

  static readonly args = {
    id: Args.string({ description: 'Operation ID', required: true }),
  };

  static readonly flags = {
    follow: Flags.boolean({
      char: 'f',
      description:
        'Keep watching until it finishes, printing each step and the new node log lines as they arrive',
      default: false,
    }),
    log: Flags.boolean({
      description:
        "Print the new node's install log captured so far (a master, or a single added worker)",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(OperationShow);
    const storage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: storage.getApiUrlOrThrow(),
      apiKey: storage.getApiKeyOrThrow(),
    });

    try {
      let op = await this.read(api, args.id);
      this.header(op);

      if (!flags.follow) {
        this.state(op);
        if (flags.log) this.print(await this.installLog(api, args.id));
        console.log('');
        return;
      }

      let lastStep = '';
      let printed = 0;
      for (;;) {
        const step = this.stepLine(op);
        if (step !== lastStep) {
          console.log(
            `  ${chalk.dim(new Date().toLocaleTimeString())}  ${step}`,
          );
          lastStep = step;
        }
        const log = await this.installLog(api, args.id);
        if (log.length > printed) {
          this.print(log.slice(printed));
          printed = log.length;
        }
        if (DONE.has(op.status)) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        op = await this.read(api, args.id);
      }
      console.log('');
      this.state(op);
      console.log('');
      if (op.status === 'FAILED') this.exit(1);
    } catch (error: any) {
      const message = error?.response?.data?.message ?? error?.message;
      console.log(chalk.red(`\n  Error: ${message}\n`));
      this.exit(1);
    }
  }

  private read(api: ApiClient, id: string): Promise<Operation> {
    return api.get<Operation>(`/infrastructure/operations/${id}`);
  }

  /** Empty where nothing was captured: most operations have no node log. */
  private async installLog(api: ApiClient, id: string): Promise<string> {
    try {
      const text = await api.get<string>(
        `/infrastructure/operations/${id}/log`,
      );
      return typeof text === 'string' ? text : '';
    } catch {
      return '';
    }
  }

  private header(op: Operation): void {
    console.log('');
    console.log(
      `  ${chalk.cyan(chalk.bold(op.operationType ?? 'operation'))}  ${op.resourceName ?? ''}  ${chalk.dim(op.id)}`,
    );
    console.log(
      `  ${chalk.dim(`started ${new Date(op.createdAt).toLocaleString()}`)}`,
    );
    console.log('');
  }

  private stepLine(op: Operation): string {
    const text = op.metadata?.message ?? '';
    return `${this.status(op.status)} ${String(op.progress ?? 0).padStart(3)}%  ${text}`;
  }

  private state(op: Operation): void {
    console.log(`  ${this.stepLine(op)}`);
    if (op.completedAt) {
      console.log(
        `  ${chalk.dim(`finished ${new Date(op.completedAt).toLocaleString()}`)}`,
      );
    }
    if (op.errorMessage) console.log(`  ${chalk.red(op.errorMessage)}`);
  }

  private status(status: Operation['status']): string {
    switch (status) {
      case 'COMPLETED':
        return chalk.green('completed');
      case 'FAILED':
        return chalk.red('failed   ');
      case 'CANCELLED':
        return chalk.yellow('cancelled');
      case 'PENDING':
        return chalk.dim('pending  ');
      default:
        return chalk.cyan('running  ');
    }
  }

  private print(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim()) console.log(chalk.dim(`    │ ${line}`));
    }
  }
}
