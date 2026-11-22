jest.mock('./external-pg.service', () => ({ ExternalPgService: class {} }));

import { MariadbImportRunner } from './mariadb-import.runner';
import { ImportContext } from './import-runner';

const source = {
  host: 'db.example.com',
  port: 3306,
  database: 'shop',
  user: 'rep',
  sslmode: 'require' as const,
};
const READY = [
  'version|12.3.3-MariaDB',
  'log_bin|ON',
  'binlog_format|ROW',
  'server_id|1',
  'tables|2',
  'GRANT RELOAD, BINLOG MONITOR, REPLICATION SLAVE ON *.* TO `rep`@`%`',
].join('\n');
const STATUS = [
  '   Master_Host: db.example.com',
  '   Slave_IO_Running: Yes',
  '   Slave_SQL_Running: Yes',
  '   Relay_Master_Log_File: binlog.000002',
  '   Exec_Master_Log_Pos: 900',
  '   Seconds_Behind_Master: 0',
].join('\n');

const replyTo = (text: string, answers: Array<[string, string]>): string =>
  answers.find(([needle]) => text.includes(needle))?.[1] ?? '';

function build() {
  const pods = {
    run: jest.fn(
      async (
        _t: unknown,
        cmd: string,
        input: string,
        _shell?: string,
      ): Promise<string> => {
        if (input.includes('VERSION()')) return READY;
        if (input.includes('information_schema.tables')) return '0\n';
        if (cmd.includes('mariadb-dump')) {
          return "-- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000002', MASTER_LOG_POS=4;\n";
        }
        if (input.includes('SHOW MASTER STATUS'))
          return 'binlog.000002\t900\t\t\n';
        if (cmd.includes('SHOW SLAVE STATUS')) return STATUS;
        return '';
      },
    ),
  };
  const ctx: ImportContext = {
    row: { source, objectName: 'x', tablesWithoutKey: [] } as never,
    target: { slug: 'mdb-1' } as never,
    targetDatabase: 'app',
    password: 'secret',
  };
  return { runner: new MariadbImportRunner(pods as never), pods, ctx };
}

describe('MariadbImportRunner', () => {
  it('checks, copies in one stream through bash, then replicates from where the copy was taken', async () => {
    const { runner, pods, ctx } = build();
    expect(await runner.copy(ctx)).toBeNull();
    const calls = pods.run.mock.calls;
    const copy = calls.find((c) => c[1].includes('mariadb-dump'))!;
    expect(copy[2]).toBe('secret\n');
    expect(copy[3]).toBe('bash');
    const start = calls.find((c) => c[2].includes('CHANGE MASTER TO'))!;
    expect(start[2]).toContain(
      "MASTER_LOG_FILE = 'binlog.000002', MASTER_LOG_POS = 4",
    );
    expect(calls.indexOf(copy)).toBeLessThan(calls.indexOf(start));
    expect(ctx.row).toMatchObject({ tablesTotal: 2, tablesCopied: 2 });
  });

  it('refuses a target that already holds tables', async () => {
    const { runner, pods, ctx } = build();
    pods.run.mockImplementation(async (_t, _c, input: string) =>
      replyTo(input, [
        ['VERSION()', READY],
        ['information_schema', '5\n'],
      ]),
    );
    expect(await runner.copy(ctx)).toContain('already holds 5 table');
    expect(pods.run.mock.calls.some((c) => c[1].includes('mariadb-dump'))).toBe(
      false,
    );
  });

  it('reports seconds behind, and calls it caught up when the source position is applied', async () => {
    const { runner, ctx } = build();
    expect(await runner.progress(ctx)).toEqual({
      streaming: true,
      lagSeconds: 0,
    });
    expect(await runner.caughtUp(ctx)).toBe(true);
  });

  it('stops waiting at once when replication has broken, saying why', async () => {
    const { runner, pods, ctx } = build();
    const broken =
      STATUS.replace('Slave_SQL_Running: Yes', 'Slave_SQL_Running: No') +
      "\n   Last_SQL_Error: Unknown database 'elsewhere'";
    pods.run.mockImplementation(async (_t, cmd: string, input: string) =>
      replyTo(`${input}\n${cmd}`, [
        ['SHOW MASTER STATUS', 'binlog.000002\t900\t\t\n'],
        ['SHOW SLAVE STATUS', broken],
      ]),
    );
    await expect(runner.caughtUp(ctx)).rejects.toThrow(
      /Replication stopped: Unknown database/,
    );
  });

  it('detaches on finish and cancel', async () => {
    const { runner, pods, ctx } = build();
    await runner.finish(ctx);
    expect(pods.run.mock.calls.pop()![2]).toContain('RESET SLAVE ALL;');
  });
});
