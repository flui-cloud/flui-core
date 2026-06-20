/**
 * The kafka-shell command grammar: a small, CLI-like language that both the AI
 * copilot targets and the command runner executes. Pure parsing — no kafkajs and
 * no I/O — so the grammar is the single source of truth for help text, the AI
 * system prompt, and execution.
 */

export type CommandVerb =
  | 'topics.list'
  | 'topic.describe'
  | 'topic.create'
  | 'topic.delete'
  | 'produce'
  | 'consume'
  | 'groups.list'
  | 'group.describe'
  | 'group.lag'
  | 'cluster.info';

export interface ParsedCommand {
  verb: CommandVerb;
  /** True when the command changes cluster state (topic create/delete, produce). */
  mutation: boolean;
  raw: string;
  topic?: string;
  group?: string;
  key?: string;
  value?: string;
  partitions?: number;
  replication?: number;
  partition?: number;
  fromEnd?: number;
  fromStart?: number;
  limit?: number;
}

export interface CommandSpec {
  usage: string;
  summary: string;
  mutation: boolean;
  example: string;
}

/** Catalog of every command — drives the help panel and the copilot system prompt. */
export const COMMAND_CATALOG: CommandSpec[] = [
  {
    usage: 'cluster info',
    summary: 'Brokers, controller and cluster id.',
    mutation: false,
    example: 'cluster info',
  },
  {
    usage: 'topics list',
    summary: 'All topics with partition count and replication factor.',
    mutation: false,
    example: 'topics list',
  },
  {
    usage: 'topic describe <name>',
    summary: 'Partitions (leader/replicas/ISR/offsets) and topic configs.',
    mutation: false,
    example: 'topic describe orders',
  },
  {
    usage: 'topic create <name> [--partitions N] [--replication R]',
    summary: 'Create a topic (defaults: 1 partition, replication 1).',
    mutation: true,
    example: 'topic create orders --partitions 3 --replication 1',
  },
  {
    usage: 'topic delete <name>',
    summary: 'Delete a topic and all its data.',
    mutation: true,
    example: 'topic delete orders',
  },
  {
    usage: 'produce <topic> [<key>] <value>',
    summary:
      'Append a record. Use --key/--value for values with spaces; quote with "…".',
    mutation: true,
    example: String.raw`produce orders user-7 "{\"total\": 42}"`,
  },
  {
    usage:
      'consume <topic> [--from-end N | --from-start N] [--partition P] [--limit N]',
    summary:
      'Read records without committing (non-destructive). Default: last 20 from the tail.',
    mutation: false,
    example: 'consume orders --from-end 20',
  },
  {
    usage: 'groups list',
    summary: 'All consumer groups.',
    mutation: false,
    example: 'groups list',
  },
  {
    usage: 'group describe <group>',
    summary: 'State, protocol and members of a consumer group.',
    mutation: false,
    example: 'group describe billing',
  },
  {
    usage: 'group lag <group>',
    summary: 'Per-partition lag (committed offset vs log end) for a group.',
    mutation: false,
    example: 'group lag billing',
  },
];

const MUTATIONS = new Set<CommandVerb>([
  'topic.create',
  'topic.delete',
  'produce',
]);

export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandParseError';
  }
}

// Consume a quoted run starting at the opening quote (a backslash escapes the
// next char). Returns the unquoted text and the index just past the closing quote.
function scanQuoted(
  input: string,
  openAt: number,
): { text: string; end: number } {
  const quote = input[openAt];
  let cur = '';
  let i = openAt + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return { text: cur, end: i + 1 };
    cur += ch;
    i++;
  }
  throw new CommandParseError(`Unterminated ${quote} quote.`);
}

/** Split a line into tokens, honouring single and double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      const q = scanQuoted(input, i);
      cur += q.text;
      started = true;
      i = q.end;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      i++;
      continue;
    }
    cur += ch;
    started = true;
    i++;
  }
  if (started) tokens.push(cur);
  return tokens;
}

interface Split {
  positionals: string[];
  flags: Record<string, string | true>;
}

function splitFlags(tokens: string[]): Split {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        flags[body] = tokens[++i];
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

function intFlag(
  flags: Record<string, string | true>,
  name: string,
): number | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (v === true) throw new CommandParseError(`--${name} needs a number.`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new CommandParseError(`--${name} must be a non-negative integer.`);
  }
  return n;
}

type MakeCommand = (
  verb: CommandVerb,
  extra: Partial<ParsedCommand>,
) => ParsedCommand;

function parseTopic(
  b: string | undefined,
  rest: string[],
  make: MakeCommand,
): ParsedCommand {
  const sub = b?.toLowerCase();
  const { positionals, flags } = splitFlags(rest);
  const name = positionals[0];
  if (sub === 'describe') {
    if (!name) throw new CommandParseError('Usage: topic describe <name>');
    return make('topic.describe', { topic: name });
  }
  if (sub === 'create') {
    if (!name)
      throw new CommandParseError(
        'Usage: topic create <name> [--partitions N] [--replication R]',
      );
    return make('topic.create', {
      topic: name,
      partitions: intFlag(flags, 'partitions'),
      replication: intFlag(flags, 'replication'),
    });
  }
  if (sub === 'delete') {
    if (!name) throw new CommandParseError('Usage: topic delete <name>');
    return make('topic.delete', { topic: name });
  }
  throw new CommandParseError(
    `Unknown topic subcommand "${b ?? ''}". Try: describe | create | delete.`,
  );
}

function parseGroup(
  b: string | undefined,
  rest: string[],
  make: MakeCommand,
): ParsedCommand {
  const sub = b?.toLowerCase();
  const { positionals } = splitFlags(rest);
  const group = positionals[0];
  if (sub === 'describe') {
    if (!group) throw new CommandParseError('Usage: group describe <group>');
    return make('group.describe', { group });
  }
  if (sub === 'lag') {
    if (!group) throw new CommandParseError('Usage: group lag <group>');
    return make('group.lag', { group });
  }
  throw new CommandParseError(
    `Unknown group subcommand "${b ?? ''}". Try: describe | lag.`,
  );
}

function parseProduce(
  b: string | undefined,
  rest: string[],
  make: MakeCommand,
): ParsedCommand {
  const { positionals, flags } = splitFlags([b, ...rest].filter(Boolean));
  const topic = positionals[0];
  if (!topic)
    throw new CommandParseError('Usage: produce <topic> [<key>] <value>');
  let key: string | undefined;
  let value: string | undefined;
  if (flags.value === undefined) {
    const tail = positionals.slice(1);
    if (tail.length >= 2) {
      key = tail[0];
      value = tail[1];
    } else if (tail.length === 1) {
      value = tail[0];
    }
    if (flags.key !== undefined && flags.key !== true) key = flags.key;
  } else {
    value = flags.value === true ? undefined : flags.value;
    key = flags.key === true ? undefined : (flags.key ?? positionals[1]);
  }
  if (value === undefined) {
    throw new CommandParseError(
      'produce needs a value: produce <topic> [<key>] <value> (or --value).',
    );
  }
  return make('produce', {
    topic,
    key,
    value,
    partition: intFlag(flags, 'partition'),
  });
}

function parseConsume(
  b: string | undefined,
  rest: string[],
  make: MakeCommand,
): ParsedCommand {
  const { positionals, flags } = splitFlags([b, ...rest].filter(Boolean));
  const topic = positionals[0];
  if (!topic)
    throw new CommandParseError(
      'Usage: consume <topic> [--from-end N | --from-start N] [--partition P] [--limit N]',
    );
  const fromEnd = intFlag(flags, 'from-end');
  const fromStart = intFlag(flags, 'from-start');
  if (fromEnd !== undefined && fromStart !== undefined) {
    throw new CommandParseError('Use only one of --from-end / --from-start.');
  }
  return make('consume', {
    topic,
    fromEnd,
    fromStart,
    partition: intFlag(flags, 'partition'),
    limit: intFlag(flags, 'limit'),
  });
}

/**
 * Parse one kafka-shell line into a structured command. Throws CommandParseError
 * with a human-readable message (shown in the runner; lets the copilot self-correct).
 */
export function parseCommand(input: string): ParsedCommand {
  const raw = input.trim();
  if (!raw) throw new CommandParseError('Empty command.');
  const tokens = tokenize(raw);
  const [a, b, ...rest] = tokens;
  const head = a.toLowerCase();
  const sub = b?.toLowerCase();

  const make: MakeCommand = (verb, extra) => ({
    verb,
    mutation: MUTATIONS.has(verb),
    raw,
    ...extra,
  });

  if (head === 'cluster' && sub === 'info') return make('cluster.info', {});
  if (head === 'topics' && sub === 'list') return make('topics.list', {});
  if (head === 'groups' && sub === 'list') return make('groups.list', {});
  if (head === 'topic') return parseTopic(b, rest, make);
  if (head === 'group') return parseGroup(b, rest, make);
  if (head === 'produce') return parseProduce(b, rest, make);
  if (head === 'consume') return parseConsume(b, rest, make);

  throw new CommandParseError(
    `Unknown command "${a}". Run a command from: cluster, topics, topic, produce, consume, groups, group.`,
  );
}
