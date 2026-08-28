import chalk from 'chalk';
import type { ProbeCard } from './context-client';
import {
  ParamAsk,
  ProbeOp,
  answerTypeOf,
  asksOf,
  isProbeOp,
  opsFor,
  paramPairs,
  readExpected,
} from './note-draft';
import type { ProbeValueType } from '../../../../src/modules/operating-context/probes/probe-expectation';
import { promptInput, selectWithArrows } from '../prompts';

/**
 * Asking for a note, one published question at a time.
 *
 * The dashboard's form does this with a `select` where the catalogue published
 * a set of accepted values and a typed box where it published a type; a
 * terminal has the same two moves — an arrow list and a validated line — and
 * they are made from the same published card. Nothing below knows the name of
 * any probe or of any parameter.
 *
 * Every point where a person would be asked is guarded first: a prompt that
 * fires with no terminal attached does not fail, it hangs, and the caller is
 * then holding a half-written note and no way to finish it.
 */
export class NothingToAskWith extends Error {
  constructor(question: string, flag: string) {
    super(`Cannot ask ${question} — no terminal attached. Pass ${flag}.`);
    this.name = 'NothingToAskWith';
  }
}

function assertCanAsk(question: string, flag: string): void {
  if (!process.stdin.isTTY) throw new NothingToAskWith(question, flag);
}

/** One of a fixed set, chosen with the arrows, or refused with the flag to use. */
export async function askOneOf<T extends string>(
  title: string,
  flag: string,
  options: ReadonlyArray<{ value: T; label: string }>,
): Promise<T> {
  assertCanAsk(title, flag);
  const picked = await selectWithArrows(
    title,
    options.map((o) => ({ label: o.label })),
  );
  if (picked < 0) throw new Error('Cancelled.');
  return options[picked].value;
}

export async function askLine(
  message: string,
  flag: string,
  validate?: (value: string) => string | null,
): Promise<string> {
  assertCanAsk(message, flag);
  return promptInput({ message, validate });
}

/**
 * The answers to the questions this fact publishes, asked one at a time.
 *
 * A parameter with a published set of accepted values is chosen from that set
 * rather than typed, which removes a whole class of avoidable refusal: there is
 * no warning to write when there is no way to get it wrong. An optional one may
 * be left blank, and a blank is dropped rather than sent — so the API's own
 * *this is missing* is the sentence that speaks, and a stale answer from a
 * previously chosen fact is never posted to one that never asked for it.
 *
 * When the card published nothing (`asksOf` answers `null`), the caller is on
 * its own and falls back to `--param name=value`. That fallback is kept
 * deliberately: a probe offered by another module may never have declared what
 * it takes, and removing the fallback would make it unwritable from here.
 */
export async function askParams(
  card: ProbeCard,
  given: readonly string[],
): Promise<Record<string, unknown>> {
  const supplied = paramPairs(given);
  const asks = asksOf(card);
  if (!asks) {
    console.log(
      chalk.dim(
        `   “${card.id}” did not publish what it is asked for. Name its parameters yourself with --param name=value.`,
      ),
    );
    return supplied;
  }

  const answers: Record<string, unknown> = {};
  const alreadyGiven = (name: string | undefined): boolean =>
    typeof name === 'string' &&
    typeof supplied[name] === 'string' &&
    !!supplied[name];

  for (const ask of asks) {
    const already = supplied[ask.name];
    if (typeof already === 'string' && already) {
      answers[ask.name] = already;
      continue;
    }
    // The pair is already satisfied by its other half, so there is nothing left
    // to ask. Without this the form asked for a parameter the author had just
    // answered under its alternative name — and, with no terminal attached,
    // refused a note that was in fact complete.
    if (alreadyGiven(ask.orElse)) continue;
    const answer = await askParam(card, ask);
    if (answer) answers[ask.name] = answer;
  }
  return answers;
}

async function askParam(card: ProbeCard, ask: ParamAsk): Promise<string> {
  const need = ask.required ? '' : ' (optional, leave blank to skip)';
  if (ask.choices) {
    if (!ask.required) {
      const options = [
        ...ask.choices.map((value) => ({ value, label: value })),
        { value: '', label: chalk.dim('(skip)') },
      ];
      return askOneOf(
        `${card.id} — ${ask.name}`,
        `--param ${ask.name}=…`,
        options,
      );
    }
    return askOneOf(
      `${card.id} — ${ask.name}`,
      `--param ${ask.name}=…`,
      ask.choices.map((value) => ({ value, label: value })),
    );
  }
  if (!ask.required) {
    assertCanAsk(ask.name, `--param ${ask.name}=…`);
    const typed = await promptInput({
      message: `${card.id} — ${ask.name}${need}`,
      allowEmpty: true,
    });
    return typed.trim();
  }
  return askLine(`${card.id} — ${ask.name}`, `--param ${ask.name}=…`);
}

/**
 * How the fact is compared, offered only where the comparison could hold.
 *
 * `atLeast` and `atMost` are absent from the list when the published answer is
 * not a number. That is the API's refusal expressed as a menu rather than as a
 * warning — the same treatment the accepted values of a parameter get — so
 * there is nothing here restating a rule that lives on the server.
 */
export async function askOp(
  type: ProbeValueType | undefined,
  given?: string,
): Promise<ProbeOp> {
  const offered = opsFor(type);
  if (given) {
    if (!isProbeOp(given)) throw new Error(`“${given}” is not a comparison.`);
    return given;
  }
  return askOneOf(
    type ? `How is it compared? (it answers a ${type})` : 'How is it compared?',
    '--op',
    offered.map((value) => ({ value, label: value })),
  );
}

/**
 * What the fact is expected to be, read in the type the fact answers in.
 *
 * The reading is refused loudly and locally, while the person is still at the
 * prompt — `three` against a fact that answers a number never leaves the
 * machine. A fact that published no type is handed over exactly as typed, which
 * is what the API does with it too.
 */
export async function askExpected(
  type: ProbeValueType | undefined,
  given?: string,
): Promise<unknown> {
  if (given !== undefined) {
    const read = readExpected(type, given);
    if ('problem' in read) throw new Error(read.problem);
    return read.value;
  }
  if (type === 'boolean') {
    const picked = await askOneOf('Expected to be', '--expected', [
      { value: 'true', label: 'true' },
      { value: 'false', label: 'false' },
    ]);
    return picked === 'true';
  }
  const typed = await askLine(
    type ? `Expected ${type}` : 'Expected value',
    '--expected',
    (value) => {
      const read = readExpected(type, value);
      return 'problem' in read ? read.problem : null;
    },
  );
  const read = readExpected(type, typed);
  return 'problem' in read ? undefined : read.value;
}

/** The published type of the answer to the question as it now stands. */
export function typeOf(
  card: ProbeCard | undefined,
  params: Record<string, unknown>,
): ProbeValueType | undefined {
  return answerTypeOf(card, params);
}
