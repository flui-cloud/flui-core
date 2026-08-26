import type { ProbeOp } from './context-probe';

/**
 * The type a probe answers in, declared by the probe itself.
 *
 * Three, because the comparisons are three: equality, ordering, presence. A
 * probe that wanted to answer an object would be a probe whose premise nobody
 * could write down, which is the same thing as a premise nobody can check.
 */
export type ProbeValueType = 'string' | 'number' | 'boolean';

/**
 * A premise that cannot be read in the type its probe answers.
 *
 * Its own class rather than a `BadRequestException` because nothing under
 * `probes/` may depend on the transport: the registry is asked this question by
 * the service at write time, and could be asked it by a CLI or a seeder later.
 */
export class ProbeExpectationProblem extends Error {}

/**
 * A premise read in the type its probe answers, or a refusal saying why.
 *
 * This is the whole of decision 166 and it sits **here**, at the moment of
 * writing, rather than in each client. The comparison in
 * {@link ../probes/context-probe#holds} is a strict `===` and the ordering
 * comparisons reject non-numbers on either side; that strictness is the
 * property to defend, not the defect — a probe that quietly matched `3` against
 * `"3"` would also quietly match `0` against `""`. What was wrong was the
 * *storage*: a form posts strings, so a premise arrived as `"3"`, sat next to a
 * `nodeCount` of `3`, and the note declared itself `broken` for a reason that
 * had never been true. A note that cries wolf about itself teaches its readers
 * that the signal means nothing, which is worse than having no signal.
 *
 * So the premise is coerced once, on the way in, into the type the probe says
 * it answers, and stored already typed. Everything downstream — the strict
 * comparison, the jsonb column, a re-read a year later — then sees a value that
 * can only disagree for a real reason.
 *
 * And when it cannot be read in that type at all, the write is **refused**.
 * Saving `"about three"` against a numeric probe would produce a note that
 * looks checked and can never hold: the honest answer is to say so to the
 * person who is still looking at the form, not to hand them a note that will
 * accuse itself tomorrow.
 */
export function interpretExpected(
  type: ProbeValueType | undefined,
  op: ProbeOp,
  expected: unknown,
): unknown {
  // `exists` asks whether the probe has an answer at all, so there is nothing
  // to compare it with. Stored as null rather than as whatever was posted: a
  // value nobody reads is a value that will be read one day by mistake.
  if (op === 'exists') return null;
  if (op === 'atLeast' || op === 'atMost') return ordered(type, op, expected);
  return equated(type, op, expected);
}

function ordered(
  type: ProbeValueType | undefined,
  op: ProbeOp,
  expected: unknown,
): number {
  // Asked of the *declared* type and not of the premise: `atLeast` on a status
  // string could never hold whatever was written next to it, and the author is
  // better told that than left with a note that is permanently unverifiable.
  if (type && type !== 'number') {
    throw new ProbeExpectationProblem(
      `This probe answers a ${type}, and “${op}” only compares numbers. Use “equals” or “notEquals”, or lean on a probe that answers a number.`,
    );
  }
  const n = asNumber(expected);
  if (n === undefined) {
    throw new ProbeExpectationProblem(
      `“${show(expected)}” is not a number, and “${op}” compares numbers. Write the premise as the number itself.`,
    );
  }
  return n;
}

function equated(
  type: ProbeValueType | undefined,
  op: ProbeOp,
  expected: unknown,
): unknown {
  if (expected === null || expected === undefined) {
    throw new ProbeExpectationProblem(
      `“${op}” needs something to compare with. To say the fact is simply there, or simply absent, use “exists”.`,
    );
  }
  // No declared type is the honest case, not a hole: a probe registered by
  // another module may not have said, and guessing on its behalf would put a
  // conversion between the note and a comparison nobody here can predict. The
  // premise is stored exactly as written.
  if (!type) return expected;
  const read = READERS[type](expected);
  if (read === undefined) {
    throw new ProbeExpectationProblem(
      `This probe answers a ${type}, and “${show(expected)}” cannot be read as one.`,
    );
  }
  return read;
}

const READERS: Record<ProbeValueType, (v: unknown) => unknown> = {
  number: (v) => asNumber(v),
  boolean: (v) => asBoolean(v),
  string: (v) => asString(v),
};

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  if (t === 'true') return true;
  return t === 'false' ? false : undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
}

/** The premise as the author wrote it, short enough to sit in a sentence. */
function show(v: unknown): string {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (v === null) return 'null';
  if (typeof v === 'object') return Array.isArray(v) ? 'a list' : 'an object';
  return String(v as number | boolean | undefined);
}
