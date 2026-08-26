import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { printContextBanner } from '../../lib/context-banner';
import {
  ContextNote,
  OperatingContextClient,
} from '../../lib/operating-context/context-client';

const CONFIDENCE: Record<ContextNote['confidence'], (s: string) => string> = {
  broken: (s) => chalk.red(s),
  stale: (s) => chalk.yellow(s),
  checked: (s) => chalk.green(s),
  unverified: (s) => chalk.dim(s),
};

const LABEL: Record<ContextNote['confidence'], string> = {
  broken: 'premise fell',
  stale: 'unconfirmed',
  checked: 'checked',
  unverified: 'prose',
};

const RANK: Record<ContextNote['confidence'], number> = {
  broken: 0,
  stale: 1,
  unverified: 2,
  checked: 3,
};

/**
 * How this installation is run, read from a terminal.
 *
 * The same delivery the dashboard reads and the same one an agent is handed
 * through `/advice`: whoever operates from here was, until now, the only reader
 * of these notes with no way to reach them.
 *
 * Suspicion first, and nothing else re-ordered — `sort` is stable, so notes of
 * equal standing keep the order the API sent them in. A note whose premise fell
 * has to be met before the ones that still hold, or re-reading is a task with
 * no end.
 */
export default class OperatingContextList extends Command {
  static readonly description =
    'The operating-context notes that reach you, each with its verdict on itself';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster prod-eu',
    '<%= config.bin %> <%= command.id %> --archived',
  ];
  static readonly flags = {
    app: Flags.string({
      description: 'Only the notes that apply to this application slug',
    }),
    cluster: Flags.string({
      description: 'Only the notes that apply to this cluster id',
    }),
    archived: Flags.boolean({
      default: false,
      description:
        'The notes that were retired, with the day and the hand that withdrew each',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(OperatingContextList);
    printContextBanner();

    const client = OperatingContextClient.fromConfig();
    const focus =
      flags.app || flags.cluster
        ? { slug: flags.app, clusterId: flags.cluster }
        : undefined;
    const notes = flags.archived
      ? await client.archive(focus)
      : await client.list(focus);

    if (flags.json) {
      this.log(JSON.stringify(notes, null, 2));
      return;
    }

    if (notes.length === 0) {
      this.log(
        chalk.dim(
          flags.archived
            ? '\n   Nothing has been retired that you can read.\n'
            : '\n   Nobody has written down how this installation is run.\n',
        ),
      );
      return;
    }

    this.log('');
    for (const note of [...notes].sort(
      (a, b) => RANK[a.confidence] - RANK[b.confidence],
    )) {
      this.print(note);
    }
  }

  private print(note: ContextNote): void {
    const paint = CONFIDENCE[note.confidence] ?? chalk.dim;
    this.log(
      `   ${chalk.bold(note.title)}  ${paint(LABEL[note.confidence] ?? note.confidence)}`,
    );
    this.log(
      chalk.dim(
        `     ${level(note)} · ${note.nature} · about ${note.topic} · ${note.checkedBy}`,
      ),
    );
    this.log(`     ${note.body}`);
    if (note.reaches) this.log(chalk.dim(`     ${note.reaches.sentence}`));
    const hands = handLine(note);
    if (hands) this.log(chalk.dim(`     ${hands}`));
    this.log('');
  }
}

function level(note: ContextNote): string {
  if (note.scopeType === 'cluster') {
    return `cluster ${note.scopeRef ?? '(unnamed)'}`;
  }
  return note.scopeType;
}

/**
 * The hands, as far as this reader is told about them.
 *
 * A hand the API withheld arrives as `null` and a hand it told with no name
 * recorded arrives as `{name: null}`. Both read the same here, because on both
 * there is no name to show — the difference is real in the type and is not a
 * difference a person can act on.
 */
function handLine(note: ContextNote): string {
  const parts: string[] = [];
  const say = (what: string, hand?: { name: string | null } | null) => {
    if (hand?.name) parts.push(`${what} ${hand.name}`);
  };
  say('written by', note.writtenBy);
  say('last confirmed by', note.confirmedBy);
  say('retired by', note.archivedBy);
  if (note.archivedAt) {
    parts.push(
      `withdrawn ${new Date(note.archivedAt).toISOString().slice(0, 10)}`,
    );
  }
  return parts.join(' · ');
}
