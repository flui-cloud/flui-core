import { DataSource } from 'typeorm';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';
import { applyActivityFilter } from './agent-activity.query';
import { REGISTER_SURFACE_UNKNOWN } from './register-surface';

/**
 * The SQL the two reads actually emit, built against Postgres metadata without
 * a database behind it.
 *
 * It exists because the rest of the suite mocks the repository, and a mock
 * cannot be wrong about a column name. Two things in particular are only
 * checkable here: that `log.args` really maps to the column called
 * `arguments` — the property and the column deliberately differ, and a query
 * naming the property would fail at runtime and nowhere else — and that the
 * per-identity fold survives the query builder intact, since it is the one
 * place this feature reaches for SQL the ORM has no opinion about.
 */
let source: DataSource;

beforeAll(async () => {
  source = new DataSource({
    type: 'postgres',
    entities: [McpToolCallLogEntity],
  });
  // Metadata only — nothing connects, and nothing here needs to. The build step
  // is protected on the class because it is an internal phase of `initialize`,
  // which would open a socket.
  await (
    source as unknown as { buildMetadatas(): Promise<void> }
  ).buildMetadatas();
});

const builder = () =>
  source.getRepository(McpToolCallLogEntity).createQueryBuilder('log');

describe('the register, as SQL', () => {
  it('pages on the columns the entity declares', () => {
    const sql = applyActivityFilter(builder(), {
      userId: 'u-1',
      actorKind: 'agent',
      operationId: 'op-1',
    })
      .orderBy('log.created_at', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .take(50)
      .getQuery();
    expect(sql).toContain('"log"."user_id" = :userId');
    expect(sql).toContain('"log"."actor_kind" = :actorKind');
    expect(sql).toContain('"log"."operation_id" = :operationId');
    expect(sql).toContain('ORDER BY "log"."created_at" DESC');
  });

  it('narrows to a request through the operations it authorised', () => {
    const sql = applyActivityFilter(builder(), {
      operationIds: ['op-1', 'op-2'],
    }).getQuery();
    expect(sql).toContain('"log"."operation_id" IN (:...operationIds)');
  });

  /**
   * The column the entity had to grow, asked for by name: a mock repository
   * cannot be wrong about a column, and this is the one place that would fail
   * against a real database if the entity and the query disagreed.
   */
  it('asks for the asking and the doing in one clause', () => {
    const sql = applyActivityFilter(builder(), {
      raisedProposalId: 'p-9',
      operationIds: ['op-1'],
    }).getQuery();
    expect(sql).toContain(
      '("log"."proposal_id" = :raisedProposalId OR "log"."operation_id" IN (:...operationIds))',
    );
  });

  /**
   * The two columns the register grew when it stopped being only MCP's. Both
   * are only ever named in SQL, so a mock repository cannot show that the
   * entity and the query agree about them.
   */
  it('narrows on the door a call came through', () => {
    const sql = applyActivityFilter(builder(), { surface: 'api' }).getQuery();
    expect(sql).toContain('"log"."surface" = :surface');
  });

  it('holds "written before the column existed" apart from "came through the API"', () => {
    const sql = applyActivityFilter(builder(), {
      surface: REGISTER_SURFACE_UNKNOWN,
    }).getQuery();
    expect(sql).toContain('"log"."surface" IS NULL');
    expect(sql).not.toContain(':surface');
  });

  it('reaches the rows that name their own answer, beside the ones that started something', () => {
    const sql = applyActivityFilter(builder(), {
      raisedProposalId: 'p-9',
      operationIds: ['op-1'],
      grantIds: ['p-9', 'c-1'],
    }).getQuery();
    expect(sql).toContain('"log"."grant_id" IN (:...grantIds)');
    expect(sql).toContain(
      '("log"."proposal_id" = :raisedProposalId OR "log"."operation_id" IN (:...operationIds) OR "log"."grant_id" IN (:...grantIds))',
    );
  });

  /**
   * The property is `args` and the column is `arguments`. Selecting the whole
   * entity is what keeps the two in step; a hand-written projection naming the
   * property would compile and then fail against the database.
   */
  it('selects the redacted arguments under their real column name', () => {
    const sql = applyActivityFilter(builder(), {}).getQuery();
    expect(sql).toContain('"log"."arguments"');
    expect(sql).not.toMatch(/"log"\."args"/);
  });

  it('folds the last activity per identity in one pass', () => {
    const sql = applyActivityFilter(builder(), { userId: 'u-1' })
      .select('log.actor_kind', 'actorKind')
      .addSelect('log.actor_key_id', 'actorKeyId')
      .addSelect('log.user_id', 'userId')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COUNT(*) FILTER (WHERE log.allowed = false)', 'refused')
      .addSelect('MAX(log.created_at)', 'lastActivityAt')
      .addSelect(
        '(array_agg(log.tool ORDER BY log.created_at DESC))[1]',
        'lastTool',
      )
      .groupBy('log.actor_kind')
      .addGroupBy('log.actor_key_id')
      .addGroupBy('log.user_id')
      .orderBy('"lastActivityAt"', 'DESC')
      .limit(100)
      .getQuery();
    expect(sql).toContain('GROUP BY "log"."actor_kind"');
    // Written with `log.x` and emitted with the alias quoted: the builder
    // rewrites identifiers inside a raw expression too, which is what makes the
    // two Postgres-specific pieces below legal SQL rather than a string that
    // happens to compile.
    expect(sql).toContain('COUNT(*) FILTER (WHERE "log"."allowed" = false)');
    expect(sql).toContain(
      '(array_agg("log"."tool" ORDER BY "log"."created_at" DESC))[1]',
    );
    expect(sql).toContain('ORDER BY "lastActivityAt" DESC');
    expect(sql).toContain('LIMIT 100');
  });
});
