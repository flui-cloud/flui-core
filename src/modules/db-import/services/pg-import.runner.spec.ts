jest.mock('../../db-lifecycle/services/db-pod-exec.service', () => ({
  DbPodExecService: class {},
}));
jest.mock('./external-pg.service', () => ({ ExternalPgService: class {} }));

import { PgImportRunner } from './pg-import.runner';
import { DbImportEntity } from '../entities/db-import.entity';
import { ImportContext } from './import-runner';

const source = {
  host: 'db.example.com',
  port: 5432,
  database: 'shop',
  user: 'replicator',
  sslmode: 'require' as const,
};
const READY_PREFLIGHT = [
  'version|160004',
  'wal_level|logical',
  'replication|true',
  'slots_free|3',
  'tables|4',
  'no_pk|public.events',
].join('\n');

const replyTo = (text: string, answers: Array<[string, string]>): string =>
  answers.find(([needle]) => text.includes(needle))?.[1] ?? '';

function build(rowFields: Partial<DbImportEntity> = {}) {
  const exec = {
    execSql: jest.fn(
      async (_t: unknown, sql: string): Promise<string> =>
        replyTo(sql, [
          ['pg_class', '0\n'],
          ['pg_subscription_rel', '0|4\n'],
        ]),
    ),
    execSqlStream: jest.fn(async () => undefined),
  };
  const external = {
    query: jest.fn(
      async (
        _t: unknown,
        _s: unknown,
        _p: string,
        sql: string,
      ): Promise<string> =>
        replyTo(sql, [
          ['wal_level', READY_PREFLIGHT],
          ['pg_wal_lsn_diff', '0\n'],
        ]),
    ),
    schemaDump: jest.fn(async () => 'CREATE TABLE public.items (id int);'),
  };
  const row = {
    id: 'imp-1',
    source,
    objectName: 'flui_import_imp1',
    tablesWithoutKey: [],
    tablesTotal: null,
    tablesCopied: null,
    lagBytes: null,
    ...rowFields,
  } as unknown as DbImportEntity;
  const ctx: ImportContext = {
    row,
    target: { slug: 'pg-1' } as never,
    targetDatabase: 'app',
    password: 'secret',
  };
  return {
    runner: new PgImportRunner(exec as never, external as never),
    exec,
    external,
    ctx,
  };
}

describe('PgImportRunner', () => {
  it('copies schema in one transaction, marks key-less tables, publishes and subscribes, in that order', async () => {
    const { runner, exec, external, ctx } = build();
    expect(await runner.copy(ctx)).toBeNull();
    expect(exec.execSqlStream).toHaveBeenCalledWith(
      expect.anything(),
      'BEGIN;\nCREATE TABLE public.items (id int);\nCOMMIT;\n',
    );
    const sourceSql = external.query.mock.calls.map((c) => c[3]);
    expect(sourceSql[1]).toBe(
      'ALTER TABLE public.events REPLICA IDENTITY FULL;',
    );
    expect(sourceSql[2]).toContain(
      'CREATE PUBLICATION flui_import_imp1 FOR ALL TABLES;',
    );
    const subscribe = exec.execSql.mock.calls
      .map((c) => c[1])
      .find((s) => s.startsWith('CREATE SUBSCRIPTION'))!;
    expect(subscribe).toContain("password=''secret''");
    expect(ctx.row).toMatchObject({
      tablesTotal: 4,
      tablesWithoutKey: ['public.events'],
    });
  });

  it('says why and writes nothing when the source is not ready', async () => {
    const { runner, exec, external, ctx } = build();
    external.query.mockResolvedValueOnce(
      READY_PREFLIGHT.replace('wal_level|logical', 'wal_level|replica'),
    );
    expect(await runner.copy(ctx)).toContain('wal_level');
    expect(exec.execSqlStream).not.toHaveBeenCalled();
  });

  it('never imports over a database that already holds tables', async () => {
    const { runner, exec, ctx } = build();
    exec.execSql.mockResolvedValueOnce('3\n');
    expect(await runner.copy(ctx)).toContain('already holds 3 table');
    expect(exec.execSqlStream).not.toHaveBeenCalled();
  });

  it('reads copied tables and the lag', async () => {
    const { runner, ctx } = build();
    expect(await runner.progress(ctx)).toEqual({
      streaming: true,
      lagSeconds: null,
    });
    expect(ctx.row).toMatchObject({
      tablesTotal: 4,
      tablesCopied: 4,
      lagBytes: '0',
    });
  });

  it('aligns sequences, then detaches and undoes what it added on the source', async () => {
    const { runner, exec, external, ctx } = build({
      tablesWithoutKey: ['public.events'],
    });
    external.query.mockImplementation(async (_t, _s, _p, sql: string) =>
      sql.includes('pg_sequences')
        ? "SELECT setval('public.items_id_seq', 42, true);\n"
        : '',
    );
    expect(await runner.finish(ctx)).toEqual([]);
    expect(exec.execSql.mock.calls.map((c) => c[1])).toEqual([
      "SELECT setval('public.items_id_seq', 42, true);\n",
      'DROP SUBSCRIPTION flui_import_imp1;',
    ]);
    const undo = external.query.mock.calls.map((c) => c[3]).pop()!;
    expect(undo).toContain('DROP PUBLICATION IF EXISTS flui_import_imp1;');
    expect(undo).toContain(
      'ALTER TABLE public.events REPLICA IDENTITY DEFAULT;',
    );
  });

  it('tells the person what to remove when the source cannot be reached to undo', async () => {
    const { runner, external, ctx } = build({
      tablesWithoutKey: ['public.events'],
    });
    external.query.mockRejectedValue(new Error('timeout'));
    const notes = await runner.cleanUp(ctx);
    expect(notes.join(' ')).toMatch(/flui_import_imp1 by hand.*public\.events/);
  });

  it('does not call it caught up while changes keep arriving', async () => {
    const { runner, external, ctx } = build();
    external.query.mockResolvedValue('4096\n');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const run = runner.caughtUp(ctx);
    await jest.advanceTimersByTimeAsync(200_000);
    jest.useRealTimers();
    expect(await run).toBe(false);
  });
});
