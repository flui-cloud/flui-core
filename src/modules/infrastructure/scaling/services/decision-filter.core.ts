import { BadRequestException } from '@nestjs/common';
import { And, In, LessThan, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import {
  DECISION_OUTCOMES,
  DecisionOutcome,
  NODE_OUTCOMES,
  SCALING_FORCES,
  ScalingForce,
} from '../scaling.core';

export interface DecisionFilter {
  outcomes?: DecisionOutcome[];
  forces?: ScalingForce[];
  since?: Date;
  until?: Date;
  /** The `at` of the last row already read: the next page starts after it. */
  before?: Date;
  /** Identical decisions in a row read as one, counted. */
  collapse?: boolean;
}

/** From query strings as they arrive; anything it cannot read is refused by name. */
export function parseDecisionFilter(query: {
  outcome?: string;
  force?: string;
  since?: string;
  until?: string;
  before?: string;
  collapse?: string;
}): DecisionFilter {
  return {
    collapse: query.collapse === 'true',
    outcomes: outcomesOf(query.outcome),
    forces: listOf(query.force, SCALING_FORCES, 'force'),
    since: dateOf(query.since, 'since'),
    until: dateOf(query.until, 'until'),
    before: dateOf(query.before, 'before'),
  };
}

export function decisionWhere(filter: DecisionFilter): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filter.outcomes?.length) where.outcome = In(filter.outcomes);
  if (filter.forces?.length) where.force = In(filter.forces);
  const bounds = [
    filter.since ? MoreThanOrEqual(filter.since) : null,
    filter.until ? LessThanOrEqual(filter.until) : null,
    filter.before ? LessThan(filter.before) : null,
  ].filter((b): b is NonNullable<typeof b> => b !== null);
  if (bounds.length === 1) where.at = bounds[0];
  if (bounds.length > 1) where.at = And(...bounds);
  return where;
}

/** `nodes` stands for every row that says a machine came or went. */
function outcomesOf(raw: string | undefined): DecisionOutcome[] | undefined {
  if (!raw) return undefined;
  const expanded = raw
    .split(',')
    .flatMap((v) => (v.trim() === 'nodes' ? NODE_OUTCOMES : [v]))
    .join(',');
  const list = listOf(expanded, DECISION_OUTCOMES, 'outcome');
  return list ? [...new Set(list)] : undefined;
}

function listOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
): T[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const wrong = values.filter((v) => !allowed.includes(v as T));
  if (wrong.length) {
    throw new BadRequestException(
      `${name} takes ${allowed.join(', ')}; not ${wrong.join(', ')}.`,
    );
  }
  return values as T[];
}

function dateOf(raw: string | undefined, name: string): Date | undefined {
  if (!raw) return undefined;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException(`${name} is not a date: ${raw}`);
  }
  return at;
}
