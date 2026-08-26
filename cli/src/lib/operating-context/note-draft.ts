import type { ProbeCard } from '../../../../src/modules/operating-context/probes/probe-catalog';
import type { ProbeValueType } from '../../../../src/modules/operating-context/probes/probe-expectation';
import {
  PROBE_OPS,
  ProbeOp,
} from '../../../../src/modules/operating-context/probes/context-probe';
import {
  CheckKind,
  CONTEXT_SCOPE_TYPES,
  ContextScopeType,
  ENTRY_NATURES,
  EntryNature,
} from '../../../../src/modules/operating-context/operating-context.core';

export {
  PROBE_OPS,
  ProbeOp,
} from '../../../../src/modules/operating-context/probes/context-probe';
export {
  CONTEXT_SCOPE_TYPES,
  ContextScopeType,
  ENTRY_NATURES,
  EntryNature,
  CheckKind,
} from '../../../../src/modules/operating-context/operating-context.core';

/**
 * Composing an operating-context note from a terminal, one question at a time.
 *
 * Everything here is a function of what `GET /operating-context/probes`
 * published. **Nothing in this file says which probes exist, what any of them
 * is called, or what any of them takes** — that contract has one home, in
 * `flui-core`'s `builtin-probes.ts`, and a second copy in the CLI would be a
 * list that goes stale in silence. `ProbeCard` is imported from there rather
 * than restated for the same reason.
 *
 * What the functions below add is the part a browser gets for free and a
 * terminal does not: turning one published parameter into one question, and
 * turning typed text into a value of the type the fact answers in.
 */

/** One published parameter, as a question to put to a person. */
export interface ParamAsk {
  name: string;
  required: boolean;
  /** The accepted values, when the catalogue published a fixed set. */
  choices?: string[];
}

/**
 * The questions to ask for this probe, or `null` when it never said.
 *
 * `null` and `[]` are different instructions and are kept apart the whole way
 * down: an empty list means *this probe takes nothing, the question is
 * complete*, and `null` means *nobody published what it takes, you are on your
 * own* — which is what the free key/value fallback is for. Collapsing the two
 * would make a probe offered by another module unwritable from the CLI.
 */
export function asksOf(card: ProbeCard | undefined): ParamAsk[] | null {
  if (!card?.takes) return null;
  return card.takes.map((p) => ({
    name: p.name,
    required: p.required,
    ...(p.oneOf?.length ? { choices: [...p.oneOf] } : {}),
  }));
}

/**
 * The type this question answers in, for these answers, or nothing.
 *
 * Read off the card and never assumed. A fact can answer text for one of its
 * questions and a number for another, so the type belongs to the *question* and
 * not to the fact — which is why the card publishes it per accepted value. A
 * probe the API published no type for gets `undefined`
 * here, and everything downstream then does what the API itself does with it —
 * stores the premise exactly as it was typed rather than guessing on its
 * behalf.
 */
export function answerTypeOf(
  card: ProbeCard | undefined,
  params: Record<string, unknown>,
): ProbeValueType | undefined {
  if (!card) return undefined;
  if (card.answers) return card.answers;
  const per = card.answersPer;
  if (!per) return undefined;
  const chosen = params[per.param];
  return typeof chosen === 'string' ? per.types[chosen] : undefined;
}

/**
 * The comparisons worth offering against an answer of this type.
 *
 * The API refuses `atLeast` / `atMost` on a fact that does not answer a number:
 * the comparison could never have held, whatever was written beside it. That
 * refusal is not repeated here as a sentence — it is expressed by not offering
 * the choice, which is what the dashboard does with the accepted values of a
 * parameter. There is nothing to warn about when there is no way to pick it.
 *
 * An unknown type offers all five. Narrowing on a guess would hide a comparison
 * the API would have accepted.
 */
export function opsFor(type: ProbeValueType | undefined): ProbeOp[] {
  if (!type || type === 'number') return [...PROBE_OPS];
  return PROBE_OPS.filter((op) => op !== 'atLeast' && op !== 'atMost');
}

/**
 * What was typed, read in the type the fact answers — or a sentence saying why
 * it cannot be.
 *
 * A terminal has only strings, so something must turn `2` into a number before
 * it is posted; the dashboard gets this for free from `<input type="number">`
 * and this is the same move, not a second copy of the server's reader. The
 * distinction is deliberate and narrow: this reads a value **in a type the API
 * published**, and refuses what will not read. It does not decide which
 * comparisons are legal, what an empty premise means, or what to do with a
 * type nobody declared — all of which stay where {@link interpretExpected}
 * already answers them.
 */
export function readExpected(
  type: ProbeValueType | undefined,
  typed: string,
): { value: unknown } | { problem: string } {
  const text = typed.trim();
  if (!text) {
    return {
      problem:
        'A comparison needs something to compare with. To say the fact is simply there, or simply absent, use “exists”.',
    };
  }
  if (type === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      return {
        problem: `That fact answers a number, and “${text}” is not one. Write it as digits.`,
      };
    }
    return { value: Number(text) };
  }
  if (type === 'boolean') {
    const lowered = text.toLowerCase();
    if (lowered !== 'true' && lowered !== 'false') {
      return {
        problem: `That fact answers true or false, and “${text}” is neither.`,
      };
    }
    return { value: lowered === 'true' };
  }
  // Unknown type included, and on purpose: the API stores an undeclared
  // premise exactly as written rather than guessing, so the CLI hands it over
  // exactly as written too.
  return { value: text };
}

/** The note being composed, before it is a request body. */
export interface NoteDraft {
  scopeType: ContextScopeType;
  scopeRef?: string | null;
  selector?: Record<string, unknown> | null;
  nature: EntryNature;
  topic: string;
  title: string;
  body: string;
  checkKind: CheckKind;
  probeId?: string;
  probeParams?: Record<string, unknown>;
  probeOp?: ProbeOp;
  probeExpected?: unknown;
  validForDays?: number;
}

/**
 * The draft as `POST /operating-context` wants it.
 *
 * Fields belonging to a check the note does not carry are left out rather than
 * sent empty: a `probeId` posted beside `checkKind: 'none'` is a premise nobody
 * will ever compare, saved next to a note that does not claim to be checked.
 * `exists` drops the expected value for the same reason the API stores null for
 * it — a value nobody reads is a value somebody reads by mistake one day.
 */
export function writeBodyOf(draft: NoteDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    scopeType: draft.scopeType,
    nature: draft.nature,
    topic: draft.topic.trim(),
    title: draft.title.trim(),
    body: draft.body.trim(),
    checkKind: draft.checkKind,
  };
  if (draft.scopeRef) body.scopeRef = draft.scopeRef;
  if (draft.selector) body.selector = draft.selector;
  if (draft.checkKind === 'attestation' && draft.validForDays) {
    body.validForDays = draft.validForDays;
  }
  if (draft.checkKind === 'probe') {
    body.probeId = draft.probeId;
    body.probeParams = draft.probeParams ?? {};
    body.probeOp = draft.probeOp;
    if (draft.probeOp !== 'exists' && draft.probeExpected !== undefined) {
      body.probeExpected = draft.probeExpected;
    }
  }
  return body;
}

/**
 * The one thing still missing, said before anything is sent.
 *
 * This is decision 178 on the other surface: the refusal belongs next to the
 * gesture, before it. Every clause below is a refusal the API already makes —
 * the point is *where* it is heard, not that it is new — and every one of them
 * is answered from the card the API published rather than from anything written
 * down here. Pass no card and the probe clauses say nothing: a CLI that guessed
 * on behalf of a catalogue it could not read would be the drift this whole
 * mechanism exists to remove.
 */
export function whatIsStillMissing(
  draft: NoteDraft,
  card?: ProbeCard,
): string | null {
  return (
    missingLevel(draft) ?? missingWords(draft) ?? missingCheck(draft, card)
  );
}

function missingLevel(draft: NoteDraft): string | null {
  if (!isScopeType(draft.scopeType)) {
    return `A level is one of ${CONTEXT_SCOPE_TYPES.join(', ')}.`;
  }
  if (draft.scopeType === 'cluster' && !draft.scopeRef) {
    return 'A cluster note names its cluster.';
  }
  if (draft.scopeType === 'selector' && !draft.selector) {
    return 'A selector note carries its selector.';
  }
  if (!isNature(draft.nature)) {
    return `A note is one of ${ENTRY_NATURES.join(', ')}.`;
  }
  return null;
}

function missingWords(draft: NoteDraft): string | null {
  if (!draft.topic.trim()) {
    return 'Give it a subject, so two notes about one thing can be seen to disagree.';
  }
  if (!draft.title.trim()) return 'Give it a title.';
  if (!draft.body.trim()) return 'Write the note itself.';
  return null;
}

function missingCheck(draft: NoteDraft, card?: ProbeCard): string | null {
  if (draft.checkKind === 'attestation' && !draft.validForDays) {
    return 'An attested note says how long the confirmation is worth.';
  }
  if (draft.checkKind !== 'probe') return null;
  if (!draft.probeId) return 'Name the live fact this note leans on.';
  if (!draft.probeOp) return 'Say how the fact is compared.';
  if (!card) return null;

  const params = draft.probeParams ?? {};
  const unanswered = missingParam(card, params);
  if (unanswered) return unanswered;

  const type = answerTypeOf(card, params);
  if (!opsFor(type).includes(draft.probeOp)) {
    return `That fact answers a ${type}, and “${draft.probeOp}” compares numbers. Compare it with “equals”, or lean on a fact that answers a number.`;
  }
  if (draft.probeOp !== 'exists' && draft.probeExpected === undefined) {
    return 'Say what the fact is expected to be.';
  }
  return null;
}

function missingParam(
  card: ProbeCard,
  params: Record<string, unknown>,
): string | null {
  for (const ask of asksOf(card) ?? []) {
    const answer = params[ask.name];
    if (ask.required && (answer === undefined || answer === '')) {
      return `“${card.id}” cannot be asked without a ${ask.name}. Say which one this note is about.`;
    }
    const outside =
      ask.choices &&
      typeof answer === 'string' &&
      answer &&
      !ask.choices.includes(answer);
    if (outside) {
      return `“${String(answer)}” is not a ${ask.name} a note may lean on; the readable ones are ${ask.choices.join(', ')}.`;
    }
  }
  return null;
}

export const isScopeType = (v: string): v is ContextScopeType =>
  (CONTEXT_SCOPE_TYPES as readonly string[]).includes(v);

export const isNature = (v: string): v is EntryNature =>
  (ENTRY_NATURES as readonly string[]).includes(v);

export const isCheckKind = (v: string): v is CheckKind =>
  ['none', 'attestation', 'probe'].includes(v);

export const isProbeOp = (v: string): v is ProbeOp =>
  (PROBE_OPS as readonly string[]).includes(v);

/**
 * `name=value` pairs off the command line, as the probe wants them.
 *
 * Only for a probe that published nothing — the declared path asks one question
 * per published parameter and never needs this. Kept because dropping it would
 * make a probe offered by another module unwritable from here, which is a
 * regression wearing the clothes of a tidy-up.
 */
export function paramPairs(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    if (name) out[name] = pair.slice(at + 1).trim();
  }
  return out;
}
