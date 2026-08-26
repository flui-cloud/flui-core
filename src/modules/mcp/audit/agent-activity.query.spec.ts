import { SelectQueryBuilder } from 'typeorm';
import {
  ACTOR_KIND_UNKNOWN,
  applyActivityFilter,
} from './agent-activity.query';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';

/** Records the conditions instead of running them: the shape is the contract. */
function recorder() {
  const conditions: Array<{ sql: string; params?: object }> = [];
  const qb = {
    andWhere: jest.fn((sql: string, params?: object) => {
      conditions.push({ sql, params });
      return qb;
    }),
  };
  return {
    conditions,
    qb: qb as unknown as SelectQueryBuilder<McpToolCallLogEntity>,
  };
}

describe('what a filter becomes', () => {
  it('constrains nothing when nothing is asked', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, {});
    expect(conditions).toEqual([]);
  });

  /**
   * `undefined` and `false` are different questions on a boolean column, and
   * `if (filter.allowed)` would have collapsed them — silently turning "show me
   * the refusals" into "show me everything", which is the one filter on this
   * screen somebody is looking at for a reason.
   */
  it('keeps "refused only" apart from "no opinion"', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, { allowed: false });
    expect(conditions).toEqual([
      { sql: 'log.allowed = :allowed', params: { allowed: false } },
    ]);
  });

  /**
   * The rows written before the actor column existed. `actor_kind = 'unknown'`
   * would match nothing; they are null, and null is not a fourth kind of actor
   * — it is the absence of the claim.
   */
  it('asks for the rows that predate the actor by their nullness', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, { actorKind: ACTOR_KIND_UNKNOWN });
    expect(conditions).toEqual([
      { sql: 'log.actor_kind IS NULL', params: undefined },
    ]);
  });

  it('ands every narrowing together', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, {
      userId: 'u-1',
      actorKind: 'agent',
      actorKeyId: 'k-1',
      tool: 'app_delete',
      outcome: 'input_required',
      operationId: 'op-1',
      since: new Date('2026-08-01T00:00:00Z'),
      until: new Date('2026-08-31T00:00:00Z'),
    });
    expect(conditions.map((c) => c.sql)).toEqual([
      'log.user_id = :userId',
      'log.actor_kind = :actorKind',
      'log.actor_key_id = :actorKeyId',
      'log.tool = :tool',
      'log.outcome = :outcome',
      'log.operation_id = :operationId',
      'log.created_at >= :since',
      'log.created_at <= :until',
    ]);
  });

  it('narrows to the operations a request authorised', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, { operationIds: ['op-1', 'op-2'] });
    expect(conditions).toEqual([
      {
        sql: 'log.operation_id IN (:...operationIds)',
        params: { operationIds: ['op-1', 'op-2'] },
      },
    ]);
  });

  /**
   * "This request authorised nothing" and "no opinion about operations" are
   * opposite answers. Left to truthiness the empty set would have dropped the
   * constraint and answered with the whole unfiltered register — and `IN ()` is
   * not legal SQL either, so it cannot simply be passed through.
   */
  it('answers a request that authorised nothing with no rows', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, { operationIds: [] });
    expect(conditions).toEqual([{ sql: '1 = 0', params: undefined }]);
  });

  /**
   * The turn that *raised* a request departed under nothing, so it is in no
   * operation set and no derivation could ever have found it. It names the
   * request in a column of its own.
   */
  it('finds the turn that raised a request', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, { raisedProposalId: 'p-9' });
    expect(conditions).toEqual([
      {
        sql: 'log.proposal_id = :raisedProposalId',
        params: { raisedProposalId: 'p-9' },
      },
    ]);
  });

  /**
   * The asking and the doing are the two halves of one question. AND-ed they
   * would answer nothing at all: no row is both the request and a departure
   * under it.
   */
  it('asks for the asking or the doing, never both at once', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, {
      raisedProposalId: 'p-9',
      operationIds: ['op-1'],
    });
    expect(conditions).toEqual([
      {
        sql: '(log.proposal_id = :raisedProposalId OR log.operation_id IN (:...operationIds))',
        params: { raisedProposalId: 'p-9', operationIds: ['op-1'] },
      },
    ]);
  });

  it('still finds the asking when the request authorised nothing', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, { raisedProposalId: 'p-9', operationIds: [] });
    expect(conditions).toEqual([
      {
        sql: 'log.proposal_id = :raisedProposalId',
        params: { raisedProposalId: 'p-9' },
      },
    ]);
  });

  /**
   * An empty string is a value somebody typed, not an absence — and on
   * `user_id` the difference decides whether a page is pinned to a person or
   * left open. Guarded with `!== undefined` rather than truthiness for that
   * reason.
   */
  it('treats an empty id as a constraint, not as "any"', () => {
    const { qb, conditions } = recorder();
    applyActivityFilter(qb, { userId: '' });
    expect(conditions).toEqual([
      { sql: 'log.user_id = :userId', params: { userId: '' } },
    ]);
  });
});
