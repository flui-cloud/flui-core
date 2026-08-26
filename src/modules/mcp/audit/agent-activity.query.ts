import { SelectQueryBuilder } from 'typeorm';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';
import { REGISTER_SURFACE_UNKNOWN } from './register-surface';

/** What the panel narrows the register by. Every field is AND-ed; absent means "any". */
export interface ActivityFilter {
  /**
   * Whose rows. Absent means every principal's, which only a caller with
   * instance reach is ever allowed to ask for — the reach is resolved before
   * this object is built, never inside the query.
   */
  userId?: string;
  actorKind?: string;
  /**
   * Which door the rows came through. `unknown` selects the ones written
   * before the column existed, which is not the same set as `api`.
   */
  surface?: string;
  actorKeyId?: string;
  tool?: string;
  outcome?: string;
  allowed?: boolean;
  operationId?: string;
  /**
   * The set a `proposalId` narrowing resolves to: every operation that started
   * under that request's answer, one-off or standing.
   *
   * A set rather than a second id column because one request can produce a
   * standing permission and that permission can carry many departures. An empty
   * array is a real answer — "the request authorised nothing" — and is held
   * apart from `undefined`, which is "no opinion".
   */
  operationIds?: string[];
  /**
   * The request whose *raising* row is wanted too — the turn that stopped to
   * ask, which departed under nothing and so appears in no operation set.
   *
   * OR-ed with `operationIds` rather than AND-ed, because the two name the two
   * halves of one question: what a request asked for, and what it went on to
   * authorise. Anded, they would answer nothing at all.
   */
  raisedProposalId?: string;
  /**
   * The answers named on the rows themselves, for a call that never started an
   * operation to carry one — see the entity's `grant_id`. OR-ed into the same
   * clause as `operationIds` and `raisedProposalId`, because all three answer
   * one question: everything one request touched.
   */
  grantIds?: string[];
  since?: Date;
  until?: Date;
}

/**
 * One place where a filter becomes SQL, because the page and the per-identity
 * summary have to answer about the same set of rows.
 *
 * Two shapes read differently on purpose: `actorKind: 'unknown'` selects the
 * rows written before the column existed. They are not "a person did it" — the
 * entity says so — so they are askable as their own bucket rather than folded
 * into any of the three real kinds. `surface` reads the same way, for a column
 * that grew for the same reason.
 */
export const ACTOR_KIND_UNKNOWN = 'unknown';

export function applyActivityFilter(
  qb: SelectQueryBuilder<McpToolCallLogEntity>,
  filter: ActivityFilter,
): SelectQueryBuilder<McpToolCallLogEntity> {
  if (filter.userId !== undefined) {
    qb.andWhere('log.user_id = :userId', { userId: filter.userId });
  }
  if (filter.actorKind === ACTOR_KIND_UNKNOWN) {
    qb.andWhere('log.actor_kind IS NULL');
  } else if (filter.actorKind !== undefined) {
    qb.andWhere('log.actor_kind = :actorKind', { actorKind: filter.actorKind });
  }
  if (filter.surface === REGISTER_SURFACE_UNKNOWN) {
    qb.andWhere('log.surface IS NULL');
  } else if (filter.surface !== undefined) {
    qb.andWhere('log.surface = :surface', { surface: filter.surface });
  }
  if (filter.actorKeyId !== undefined) {
    qb.andWhere('log.actor_key_id = :actorKeyId', {
      actorKeyId: filter.actorKeyId,
    });
  }
  if (filter.tool !== undefined) {
    qb.andWhere('log.tool = :tool', { tool: filter.tool });
  }
  if (filter.outcome !== undefined) {
    qb.andWhere('log.outcome = :outcome', { outcome: filter.outcome });
  }
  if (filter.allowed !== undefined) {
    qb.andWhere('log.allowed = :allowed', { allowed: filter.allowed });
  }
  if (filter.operationId !== undefined) {
    qb.andWhere('log.operation_id = :operationId', {
      operationId: filter.operationId,
    });
  }
  applyRequestNarrowing(qb, filter);
  if (filter.since) {
    qb.andWhere('log.created_at >= :since', { since: filter.since });
  }
  if (filter.until) {
    qb.andWhere('log.created_at <= :until', { until: filter.until });
  }
  return qb;
}

/**
 * The three ways a row can name one request, OR-ed into a single clause.
 *
 * They are three because a request is answered in more than one shape: the turn
 * that *asked* names it in a column of its own, a call that departed under the
 * answer names it through the operation it started, and a call that started no
 * operation — everything the door writes, since a guard runs before the handler
 * — names the grant directly. AND-ed, the three would answer nothing at all.
 */
function applyRequestNarrowing(
  qb: SelectQueryBuilder<McpToolCallLogEntity>,
  filter: ActivityFilter,
): void {
  if (
    filter.operationIds === undefined &&
    filter.raisedProposalId === undefined &&
    filter.grantIds === undefined
  ) {
    return;
  }
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.raisedProposalId !== undefined) {
    parts.push('log.proposal_id = :raisedProposalId');
    params.raisedProposalId = filter.raisedProposalId;
  }
  // `IN ()` is not legal SQL and TypeORM refuses to build it, so the empty set
  // is spelled out rather than left to the driver. It has to mean "no rows":
  // collapsing it to "no constraint" would answer a narrowing that matched
  // nothing with the whole unfiltered register.
  if (filter.operationIds?.length) {
    parts.push('log.operation_id IN (:...operationIds)');
    params.operationIds = filter.operationIds;
  }
  if (filter.grantIds?.length) {
    parts.push('log.grant_id IN (:...grantIds)');
    params.grantIds = filter.grantIds;
  }
  if (!parts.length) qb.andWhere('1 = 0');
  else if (parts.length === 1) qb.andWhere(parts[0], params);
  else qb.andWhere(`(${parts.join(' OR ')})`, params);
}
