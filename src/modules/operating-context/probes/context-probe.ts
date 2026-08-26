import { Injectable, Logger } from '@nestjs/common';
import { ProbeStatus } from '../operating-context.core';
import {
  ProbeExpectationProblem,
  ProbeValueType,
  interpretExpected,
} from './probe-expectation';

import type { ProbeParam } from './probe-catalog';

export {
  ProbeExpectationProblem,
  ProbeValueType,
  interpretExpected,
} from './probe-expectation';

export { ProbeCard, ProbeParam, probeCards, taken } from './probe-catalog';

/**
 * A named, read-only question about live state that an entry may lean on.
 *
 * The registry shape rather than a query language, and the reason is the
 * boundary this feature must not cross: state belongs to the modules that own
 * it, and a general expression evaluated against the database would be a second
 * way to read everything — one with no permission gate on it, since it runs on
 * behalf of an entry rather than a person. A probe is a function a module
 * *offers*, with an allow-list of what it will answer.
 *
 * `run` returning a value means the question was answerable. Throwing means it
 * was not, and that becomes `unknown` — never `broken`. The difference matters
 * more than anything else here: an entry must not withdraw itself because
 * something was briefly unreachable.
 */
export interface ContextProbe {
  id: string;
  /** One line, shown to whoever is writing an entry against this probe. */
  describes: string;
  /**
   * The parameters this probe is asked for, published by the catalogue.
   *
   * Optional because a probe offered by another module may not have said, and
   * *asks for nothing* must stay distinguishable from *did not say*. Declaring
   * it is not a promise made twice: {@link taken} reads a parameter through
   * this list, so what the catalogue publishes and what the probe enforces
   * cannot come apart.
   */
  takes?: readonly ProbeParam[];
  /**
   * The type this probe answers in, for these parameters, so that a premise
   * written against it can be read in that type before it is stored.
   *
   * Per-parameters and not per-probe, because `app.field` answers a string for
   * `status` and a number for `replicas`: the type is a property of the
   * question, not of the probe. Optional, because a probe offered by another
   * module may not have said — and {@link interpretExpected} stores the premise
   * as written rather than guessing on its behalf.
   *
   * Free to throw. A parameter set it will not answer at all is a note that
   * could never be checked, and the write is refused with what it said.
   */
  answers?(params: Record<string, unknown>): ProbeValueType | undefined;
  run(params: Record<string, unknown>): Promise<unknown>;
}

export type ProbeOp = 'equals' | 'notEquals' | 'atLeast' | 'atMost' | 'exists';

export const PROBE_OPS: ProbeOp[] = [
  'equals',
  'notEquals',
  'atLeast',
  'atMost',
  'exists',
];

export interface ProbeOutcome {
  status: ProbeStatus;
  detail: string;
}

@Injectable()
export class ContextProbeRegistry {
  private readonly logger = new Logger(ContextProbeRegistry.name);
  private readonly probes = new Map<string, ContextProbe>();

  register(probe: ContextProbe): void {
    this.probes.set(probe.id, probe);
  }

  get(id: string): ContextProbe | undefined {
    return this.probes.get(id);
  }

  list(): ContextProbe[] {
    return [...this.probes.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Ask a probe and compare its answer with what the entry claims.
   *
   * Never throws. An unregistered probe, a parameter it rejects, a repository
   * that is down — all of them are `unknown`, which delivers the entry as
   * unverified prose. The only path to `broken` is a probe that answered and
   * disagreed.
   */
  async evaluate(
    probeId: string | null | undefined,
    params: Record<string, unknown> | null | undefined,
    op: string | null | undefined,
    expected: unknown,
  ): Promise<ProbeOutcome> {
    const probe = probeId ? this.get(probeId) : undefined;
    if (!probe) {
      return {
        status: 'unknown',
        detail: `no probe named ${probeId ?? '(none)'}`,
      };
    }
    let actual: unknown;
    try {
      actual = await probe.run(params ?? {});
    } catch (e) {
      this.logger.debug(`probe ${probe.id} could not answer: ${asText(e)}`);
      return { status: 'unknown', detail: 'the probe could not answer' };
    }
    return compare(op, actual, expected);
  }

  /**
   * A premise read in the type its probe answers, for the moment it is written.
   *
   * The counterpart of {@link evaluate} and deliberately its opposite in
   * temper: evaluation never throws, because a note must not withdraw itself
   * over a repository that was briefly away, while writing refuses loudly,
   * because a premise nobody can ever check is a defect the author can still
   * fix. See {@link interpretExpected}.
   */
  interpret(
    probeId: string | null | undefined,
    params: Record<string, unknown> | null | undefined,
    op: ProbeOp,
    expected: unknown,
  ): unknown {
    const probe = probeId ? this.get(probeId) : undefined;
    if (!probe) {
      throw new ProbeExpectationProblem(
        `Nothing here offers a fact called “${probeId ?? ''}”. A note can only lean on a probe this installation registers.`,
      );
    }
    let type: ProbeValueType | undefined;
    try {
      type = probe.answers?.(params ?? {});
    } catch (e) {
      throw new ProbeExpectationProblem(
        `The probe “${probe.id}” will not answer that: ${asText(e)}.`,
      );
    }
    return interpretExpected(type, op, expected);
  }
}

function asText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e !== null && typeof e === 'object') return JSON.stringify(e);
  return String(e as string | number | boolean | null | undefined);
}

function compare(
  op: string | null | undefined,
  actual: unknown,
  expected: unknown,
): ProbeOutcome {
  const held = holds(op, actual, expected);
  if (held === undefined) {
    return { status: 'unknown', detail: `cannot compare with "${op ?? ''}"` };
  }
  return {
    status: held ? 'holds' : 'broken',
    // The *shape* of the disagreement, not the value: a probe answers over an
    // allow-listed field, but the detail string ends up in a delivery a model
    // reads, and "what it actually is" is state — which this layer reports and
    // never stores.
    detail: held ? `${op} held` : `${op} no longer holds`,
  };
}

function holds(
  op: string | null | undefined,
  actual: unknown,
  expected: unknown,
): boolean | undefined {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'atLeast':
      return numeric(actual, expected, (a, b) => a >= b);
    case 'atMost':
      return numeric(actual, expected, (a, b) => a <= b);
    default:
      return undefined;
  }
}

function numeric(
  actual: unknown,
  expected: unknown,
  cmp: (a: number, b: number) => boolean,
): boolean | undefined {
  if (typeof actual !== 'number' || typeof expected !== 'number')
    return undefined;
  return cmp(actual, expected);
}
