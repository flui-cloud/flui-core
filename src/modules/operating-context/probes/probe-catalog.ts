import type { ContextProbe } from './context-probe';
import { ProbeValueType } from './probe-expectation';

/**
 * One parameter a probe is asked for, declared beside the code that reads it.
 *
 * The declaration is not documentation: {@link taken} is the only way the
 * shipped probes read a parameter, so *required* and *the values it accepts*
 * have exactly one statement each. Delete a line here and the probe stops
 * asking for it — which is what makes publishing this list safe to believe.
 */
export interface ProbeParam {
  name: string;
  required: boolean;
  /** The values it accepts, when it accepts a fixed set of them. */
  oneOf?: readonly string[];
}

/**
 * A probe as the catalogue publishes it: enough to compose a premise, and
 * nothing else.
 *
 * The write refuses a premise it cannot check — an unregistered probe, a
 * parameter set the probe will not answer, a value that cannot be read in the
 * type the question answers. Until this card existed the catalogue said only
 * `id` and `describes`, so a form offering a free key/value editor could not
 * know that `app.field` wants a `slug`: a refusal nobody could have avoided.
 *
 * What is deliberately absent is anything about the installation itself. The
 * values here are the *names of fields a note may lean on* — the same ones
 * `describes` has always said out loud — never their contents, never how many
 * of anything exists. This route is open to whoever may read an application,
 * which includes people who do not run the place.
 */
export interface ProbeCard {
  id: string;
  describes: string;
  /**
   * Absent, rather than empty, when the probe never declared its parameters.
   *
   * A probe offered by another module may not have said, and *takes nothing*
   * and *did not say* are different instructions to whoever is writing the
   * note: the first means the question is complete, the second means the
   * author is on their own.
   */
  takes?: ProbeParam[];
  /** The type it answers in, when that does not depend on the parameters. */
  answers?: ProbeValueType;
  /**
   * When it does depend: which parameter decides, and the type per value.
   *
   * `app.field` answers a string for `status` and a number for `replicas`, so
   * the type is a property of the question and not of the probe — the same
   * reason `ContextProbe.answers` is a function. Derived by *asking the probe*
   * once per accepted value, never by copying the table it reads.
   */
  answersPer?: { param: string; types: Record<string, ProbeValueType> };
}

/**
 * The catalogue, derived from what the probes already know.
 *
 * Nothing here is transcribed. The accepted values come off the probe's own
 * declaration, and the answer types come from calling {@link
 * ContextProbe.answers} — so a field added to a probe's table appears here with
 * its type, and a field removed disappears, without this file being opened. A
 * hand-kept second list of what each probe wants is the one thing this must not
 * become: it would be a contract that drifts silently, which is worse than the
 * silence it replaced.
 */
export function probeCards(probes: readonly ContextProbe[]): ProbeCard[] {
  return probes.map((probe) => ({
    id: probe.id,
    describes: probe.describes,
    ...(probe.takes ? { takes: [...probe.takes] } : {}),
    ...answersOf(probe),
  }));
}

/**
 * The per-value types are worked out **first**, and the single type is only
 * published when every accepted value agrees on it.
 *
 * Asking the probe with no parameters at all and believing the answer would be
 * the cheaper order and the wrong one: a probe that tolerates a missing
 * parameter would have one of its types published as *the* type, and a value
 * the probe answers no type for at all — the honest case, and the one a form
 * must not silently validate against the wrong reader — would disappear behind
 * its neighbours.
 */
function answersOf(
  probe: ContextProbe,
): Pick<ProbeCard, 'answers' | 'answersPer'> {
  if (!probe.answers) return {};
  const per = perValue(probe);
  if (per) {
    const distinct = new Set(Object.values(per.types));
    const typedAll = Object.keys(per.types).length === per.values;
    if (distinct.size === 1 && typedAll) {
      return { answers: [...distinct][0] };
    }
    return { answersPer: { param: per.param, types: per.types } };
  }
  const flat = asked(probe, {});
  return flat ? { answers: flat } : {};
}

function perValue(probe: ContextProbe):
  | {
      param: string;
      values: number;
      types: Record<string, ProbeValueType>;
    }
  | undefined {
  for (const param of probe.takes ?? []) {
    if (!param.oneOf?.length) continue;
    const types: Record<string, ProbeValueType> = {};
    for (const value of param.oneOf) {
      const type = asked(probe, { [param.name]: value });
      if (type) types[value] = type;
    }
    if (Object.keys(types).length) {
      return { param: param.name, values: param.oneOf.length, types };
    }
  }
  return undefined;
}

/**
 * Asking is allowed to fail: a probe declares its type by refusing the
 * parameters it cannot answer, and the refusal is the answer *for the
 * catalogue* — that combination simply has no published type.
 */
function asked(
  probe: ContextProbe,
  params: Record<string, unknown>,
): ProbeValueType | undefined {
  try {
    return probe.answers?.(params);
  } catch {
    return undefined;
  }
}

/**
 * One declared parameter, read and checked, or a refusal a person can act on.
 *
 * Every shipped probe reads its parameters through here, which is what keeps
 * {@link ProbeCard.takes} honest: the list published to an author and the list
 * enforced on the write are the same array. The messages are written to be
 * read by a person, because the write refuses with them while the form is
 * still open.
 *
 * A parameter that was not declared is a programming mistake here rather than
 * an author's, and says so.
 */
export function taken(
  params: Record<string, unknown>,
  takes: readonly ProbeParam[],
  name: string,
): string {
  const declared = takes.find((p) => p.name === name);
  if (!declared) {
    throw new Error(`nothing here reads a parameter called ${name}`);
  }
  const raw = params[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    if (declared.required) throw new Error(`${name} is missing`);
    return '';
  }
  if (declared.oneOf && !declared.oneOf.includes(value)) {
    throw new Error(
      `“${value}” is not a ${name} a note may lean on; the readable ones are ${declared.oneOf.join(', ')}`,
    );
  }
  return value;
}
