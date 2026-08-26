import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { printContextBanner } from '../../lib/context-banner';
import {
  ContextNote,
  OperatingContextClient,
  ProbeCard,
} from '../../lib/operating-context/context-client';
import {
  CheckKind,
  CONTEXT_SCOPE_TYPES,
  ContextScopeType,
  ENTRY_NATURES,
  EntryNature,
  NoteDraft,
  PROBE_OPS,
  isCheckKind,
  whatIsStillMissing,
  writeBodyOf,
} from '../../lib/operating-context/note-draft';
import {
  askExpected,
  askLine,
  askOneOf,
  askOp,
  askParams,
  typeOf,
} from '../../lib/operating-context/ask-note';
import { confirmPrompt } from '../../lib/prompts';

const NATURE_MEANS: Record<EntryNature, string> = {
  practice:
    'How it is done here — reaches everyone who acts at this level, owner or not',
  rationale:
    'Why it is done — stays with whoever’s access covers the whole level',
};

const CHECK_MEANS: Record<CheckKind, string> = {
  none: 'prose — nothing compares it with anything',
  attestation: 'a person’s signature, with a shelf life',
  probe: 'compared with live state every time it is read',
};

/**
 * Write one operating-context note, composed a question at a time.
 *
 * Two properties are the whole point of the command:
 *
 *  - **the check is composed from the published catalogue.** Which facts exist,
 *    what each is asked for and what it answers all come from
 *    `GET /operating-context/probes`. Before this, a note could be posted from
 *    a terminal against a probe nobody could enumerate, and the refusal arrived
 *    as a 400 the author had no way of preventing;
 *  - **who will read it is said before it is written.** `GET /reach` answers
 *    the one thing about these notes that surprises people — a global practice
 *    descends to every tenant and to the guests of the demonstration — and it
 *    is asked here, next to the gesture, rather than discovered on re-reading.
 *    Asked, not phrased: the sentence is computed in one place so the
 *    dashboard, this command and the sentence a person approves in the action
 *    cycle cannot come apart.
 */
export default class OperatingContextWrite extends Command {
  static readonly description =
    'Write a note about how this installation is run, at a level you cover';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --level cluster --cluster prod-eu --nature practice',
  ];
  static readonly flags = {
    level: Flags.string({
      options: [...CONTEXT_SCOPE_TYPES],
      description: 'Where the note applies',
    }),
    cluster: Flags.string({ description: 'The cluster, for a cluster note' }),
    selector: Flags.string({
      description:
        'The selector, as JSON, for a selector note — passed to the API unchanged',
    }),
    nature: Flags.string({ options: [...ENTRY_NATURES] }),
    topic: Flags.string({
      description: 'The subject two notes could disagree about',
    }),
    title: Flags.string(),
    body: Flags.string({ description: 'The note itself' }),
    check: Flags.string({
      options: ['none', 'attestation', 'probe'],
      description: 'How the premise is checked',
    }),
    'valid-for-days': Flags.integer({
      description: 'How long a signature is worth, for an attested note',
    }),
    probe: Flags.string({ description: 'The live fact the note leans on' }),
    param: Flags.string({
      multiple: true,
      description: 'name=value for the fact, repeatable',
    }),
    op: Flags.string({ options: [...PROBE_OPS] }),
    expected: Flags.string({ description: 'What the fact is expected to be' }),
    yes: Flags.boolean({
      default: false,
      description: 'Do not ask to confirm',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(OperatingContextWrite);
    printContextBanner();
    const client = OperatingContextClient.fromConfig();

    const scopeType = (flags.level as ContextScopeType) ?? (await askLevel());
    const scopeRef =
      scopeType === 'cluster'
        ? (flags.cluster ?? (await askLine('Which cluster', '--cluster')))
        : null;
    const selector =
      scopeType === 'selector' ? parseSelector(flags.selector) : null;

    const nature =
      (flags.nature as EntryNature) ??
      (await askOneOf<EntryNature>('What kind of note is it?', '--nature', [
        { value: 'practice', label: NATURE_MEANS.practice },
        { value: 'rationale', label: NATURE_MEANS.rationale },
      ]));

    // Before a word of it is written, and not after: this is the sentence the
    // whole reach mechanism exists to put in front of the author.
    const reach = await client.reach(scopeType, nature, scopeRef);
    this.log(chalk.dim(`\n   ${reach.sentence}\n`));

    const draft: NoteDraft = {
      scopeType,
      scopeRef,
      selector,
      nature,
      topic: flags.topic ?? (await askLine('Subject', '--topic')),
      title: flags.title ?? (await askLine('Title', '--title')),
      body: flags.body ?? (await askLine('The note itself', '--body')),
      checkKind: await this.checkKind(flags.check),
    };

    if (draft.checkKind === 'attestation') {
      draft.validForDays =
        flags['valid-for-days'] ??
        Number(
          await askLine('Worth how many days', '--valid-for-days', (v) =>
            /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 365
              ? null
              : 'A number of days between 1 and 365.',
          ),
        );
    }

    const card =
      draft.checkKind === 'probe'
        ? await this.leanOn(client, draft, flags)
        : undefined;

    const missing = whatIsStillMissing(draft, card);
    if (missing) {
      this.log(chalk.red(`\n   ${missing}\n`));
      this.exit(1);
    }

    if (!flags.yes && !(await this.agreed(draft, reach.sentence))) {
      this.log(chalk.dim('\n   Nothing written.\n'));
      return;
    }

    const written = await client.write(writeBodyOf(draft));
    if (flags.json) {
      this.log(JSON.stringify(written, null, 2));
      return;
    }
    this.said(written, reach.sentence);
  }

  private async checkKind(given?: string): Promise<CheckKind> {
    if (given && isCheckKind(given)) return given;
    return askOneOf<CheckKind>('How is the premise checked?', '--check', [
      { value: 'none', label: CHECK_MEANS.none },
      { value: 'attestation', label: CHECK_MEANS.attestation },
      { value: 'probe', label: CHECK_MEANS.probe },
    ]);
  }

  /**
   * The fact the note leans on, chosen from what this installation publishes.
   *
   * The catalogue is fetched, not remembered: a fact offered by a module this
   * CLI has never heard of is offered here the day it registers.
   */
  private async leanOn(
    client: OperatingContextClient,
    draft: NoteDraft,
    flags: { probe?: string; param?: string[]; op?: string; expected?: string },
  ): Promise<ProbeCard | undefined> {
    const cards = await client.probes();
    if (cards.length === 0) {
      throw new Error(
        'Nothing on this installation offers a fact a note can lean on.',
      );
    }
    const card = flags.probe
      ? cards.find((c) => c.id === flags.probe)
      : cards[
          await pickIndex(
            'Which fact does it lean on?',
            cards.map((c) => `${c.id}  —  ${c.describes}`),
          )
        ];
    if (!card) {
      throw new Error(
        `Nothing here offers a fact called “${flags.probe}”. Run \`flui operating-context probes\` to see what does.`,
      );
    }

    draft.probeId = card.id;
    draft.probeParams = await askParams(card, flags.param ?? []);
    const type = typeOf(card, draft.probeParams);
    draft.probeOp = await askOp(type, flags.op);
    if (draft.probeOp !== 'exists') {
      draft.probeExpected = await askExpected(type, flags.expected);
    }
    return card;
  }

  private async agreed(draft: NoteDraft, sentence: string): Promise<boolean> {
    this.log('');
    this.log(`   ${chalk.bold(draft.title)}`);
    this.log(
      chalk.dim(
        `     ${draft.scopeType} · ${draft.nature} · about ${draft.topic}`,
      ),
    );
    this.log(`     ${draft.body}`);
    this.log(chalk.dim(`     ${sentence}`));
    this.log('');
    return confirmPrompt('   Write it?', true);
  }

  private said(note: ContextNote, sentence: string): void {
    this.log('');
    this.log(`   ${chalk.green('written')}  ${chalk.bold(note.title)}`);
    this.log(chalk.dim(`     ${note.confidence} · ${note.checkedBy}`));
    this.log(chalk.dim(`     ${note.reaches?.sentence ?? sentence}`));
    this.log('');
  }
}

async function askLevel(): Promise<ContextScopeType> {
  return askOneOf<ContextScopeType>('Where does it apply?', '--level', [
    { value: 'global', label: 'the whole installation' },
    { value: 'cluster', label: 'one cluster' },
    { value: 'selector', label: 'the resources a rule selects' },
  ]);
}

async function pickIndex(title: string, labels: string[]): Promise<number> {
  const chosen = await askOneOf(
    title,
    '--probe',
    labels.map((label, i) => ({ value: String(i), label })),
  );
  return Number(chosen);
}

/**
 * The selector, handed over exactly as it was written.
 *
 * Not validated here beyond being JSON: the axes of a selector are the grant
 * model's, they are checked where that model lives, and a second opinion about
 * them in the CLI would be a copy that goes stale the day an axis is added.
 */
function parseSelector(text?: string): Record<string, unknown> {
  if (!text) {
    throw new Error(
      'A selector note carries its selector. Pass it as JSON with --selector.',
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('--selector must be a JSON object.');
  }
}
