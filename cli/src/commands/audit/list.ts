import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface AuditEvent {
  id: string;
  at: string;
  email: string | null;
  actorKind: string | null;
  action: string;
  target: Record<string, string> | null;
  status: number | null;
  outcome: 'ok' | 'refused' | 'failed';
  dataAccess: boolean;
}

const SINCE_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function sinceOf(value: string): string {
  const duration = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (duration) {
    const ms = Number(duration[1]) * SINCE_UNITS[duration[2].toLowerCase()];
    return new Date(Date.now() - ms).toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      `--since takes a duration back from now (30m, 8h, 7d) or a date: got "${value}".`,
    );
  }
  return date.toISOString();
}

function outcomeLabel(outcome: AuditEvent['outcome']): string {
  if (outcome === 'ok') return chalk.green('ok');
  if (outcome === 'refused') return chalk.red('refused');
  return chalk.yellow('failed');
}

function actorLabel(e: AuditEvent): string {
  const kind = e.actorKind && e.actorKind !== 'user' ? ` (${e.actorKind})` : '';
  return `${e.email ?? 'platform'}${kind}`;
}

function targetLabel(target: AuditEvent['target']): string {
  if (!target) return '';
  return chalk.dim(
    ' ' +
      Object.entries(target)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );
}

function formatEvent(e: AuditEvent): string {
  const when = e.at.replace('T', ' ').slice(0, 19);
  const data = e.dataAccess ? chalk.magenta(' data') : '';
  return `  ${chalk.dim(when)}  ${actorLabel(e)}  ${e.action}${targetLabel(e.target)}  ${outcomeLabel(e.outcome)}${data}`;
}

function buildQuery(flags: {
  limit: number;
  user?: string;
  data: boolean;
  refused: boolean;
  before?: string;
}): URLSearchParams {
  const query = new URLSearchParams({ limit: String(flags.limit) });
  if (flags.user) query.set('email', flags.user);
  if (flags.before) query.set('before', flags.before);
  if (flags.data) query.set('dataAccess', 'true');
  if (flags.refused) query.set('outcome', 'refused');
  return query;
}

function nextPageFlags(argv: string[]): string {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--before') {
      i++;
      continue;
    }
    if (argv[i].startsWith('--before=')) continue;
    kept.push(argv[i].includes(' ') ? JSON.stringify(argv[i]) : argv[i]);
  }
  return kept.length ? ` ${kept.join(' ')}` : '';
}

export default class AuditList extends Command {
  static readonly description =
    'Who did what on this installation: every change, every refusal and every read of application data, newest first.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --user support@partner.example --since 7d',
    '<%= config.bin %> <%= command.id %> --data',
    '<%= config.bin %> <%= command.id %> --refused --since 24h',
    '<%= config.bin %> <%= command.id %> --before <id of the last record shown>',
  ];

  static readonly flags = {
    user: Flags.string({ description: 'Only what this person did (email)' }),
    since: Flags.string({
      description: 'From this far back (30m, 8h, 7d) or from a date',
    }),
    data: Flags.boolean({
      description: 'Only actions that reached application data',
      default: false,
    }),
    refused: Flags.boolean({
      description: 'Only what was refused',
      default: false,
    }),
    before: Flags.string({
      description: 'Only records older than this one (its id): the next page',
    }),
    limit: Flags.integer({
      description: 'How many records',
      default: 50,
      min: 1,
      max: 500,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['text', 'json'],
      default: 'text',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuditList);
    const query = buildQuery(flags);
    if (flags.since) {
      try {
        query.set('since', sinceOf(flags.since));
      } catch (error: unknown) {
        this.error((error as Error).message, { exit: 1 });
      }
    }

    const configStorage = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: configStorage.getApiUrlOrThrow(),
      apiKey: configStorage.getApiKeyOrThrow(),
    });

    let events: AuditEvent[];
    try {
      events = await api.get<AuditEvent[]>(`/audit/events?${query}`);
    } catch (error: unknown) {
      this.error(
        `Could not read the audit record: ${(error as Error).message}`,
        {
          exit: 1,
        },
      );
    }

    if (flags.output === 'json') {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log(chalk.dim('\n  Nothing recorded for this filter.\n'));
      return;
    }

    console.log('');
    for (const e of events) console.log(formatEvent(e));
    console.log('');
    if (events.length === flags.limit) {
      console.log(
        chalk.dim(
          `  Older records: ${this.config.bin} audit list --before ${events[events.length - 1].id}${nextPageFlags(this.argv)}\n`,
        ),
      );
    }
  }
}
