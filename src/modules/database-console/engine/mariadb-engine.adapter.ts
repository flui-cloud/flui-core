import { BadRequestException, Injectable } from '@nestjs/common';
import {
  createConnection,
  type Connection,
  type FieldPacket,
} from 'mysql2/promise';
import { DbEngine } from '../interfaces/db-connection';
import {
  SchemaColumn,
  SchemaTable,
  SchemaTree,
  SqlEngineAdapter,
  SqlEngineConnectParams,
  SqlEngineConnection,
  SqlQueryOptions,
  SqlQueryResult,
} from './sql-engine';

// mysql2 reports column types as numeric codes; map the common ones for the grid
// header. Unknowns fall back to `type:<n>` rather than pulling a catalog per query.
const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  252: 'text',
  253: 'varchar',
  254: 'char',
};

function mysqlTypeName(code?: number): string {
  if (code === undefined) return '';
  return MYSQL_TYPE_NAMES[code] ?? `type:${code}`;
}

// First keyword of the statement — mysql2 gives no "command" tag like pg does.
function commandOf(sql: string): string {
  return /^[\s;]*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase() ?? '';
}

interface OkPacketLike {
  affectedRows?: number;
}

class MariadbConnection implements SqlEngineConnection {
  constructor(
    private readonly conn: Connection,
    private readonly database: string,
  ) {}

  async query(sql: string, opts: SqlQueryOptions): Promise<SqlQueryResult> {
    const start = Date.now();
    // MariaDB measures max_statement_time in (fractional) seconds, not ms.
    const seconds = Math.max(0.001, opts.statementTimeoutMs / 1000);
    await this.conn.query(`SET SESSION max_statement_time = ${seconds}`);
    await this.conn.query(
      opts.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION',
    );
    try {
      const [rows, fields] = (await this.conn.query({
        sql,
        rowsAsArray: true,
      })) as [unknown, FieldPacket[] | undefined];

      // Read-only sessions never persist; writes (future per-user roles) commit.
      await this.conn.query(opts.readOnly ? 'ROLLBACK' : 'COMMIT');

      // SELECT → array of array-rows; INSERT/UPDATE/DELETE → an OkPacket.
      if (Array.isArray(rows)) {
        const allRows = rows as unknown[][];
        const truncated = allRows.length > opts.maxRows;
        return {
          command: commandOf(sql),
          columns: (fields ?? []).map((f) => ({
            name: f.name,
            dataType: mysqlTypeName((f as { columnType?: number }).columnType),
          })),
          rows: truncated ? allRows.slice(0, opts.maxRows) : allRows,
          rowCount: allRows.length,
          truncated,
          durationMs: Date.now() - start,
        };
      }
      const ok = rows as OkPacketLike;
      return {
        command: commandOf(sql),
        columns: [],
        rows: [],
        rowCount: ok.affectedRows ?? 0,
        truncated: false,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      await this.conn.query('ROLLBACK').catch(() => undefined);
      throw mapMysqlError(err);
    }
  }

  // In MySQL/MariaDB a "schema" IS a database, so the tree carries a single
  // namespace (the connected database) to keep the same shape as Postgres.
  async introspect(): Promise<SchemaTree> {
    const db = this.database;
    const [verRows] = (await this.conn.query('SELECT VERSION() AS v')) as [
      { v: string }[],
      unknown,
    ];
    // information_schema column identifiers are uppercase in the catalog; alias them to a
    // known lowercase label so the result keys are stable regardless of server/driver case.
    const [tableRows] = (await this.conn.query(
      `SELECT table_name AS t, table_type AS tt, table_rows AS rows_est
         FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY table_name`,
      [db],
    )) as [{ t: string; tt: string; rows_est: number | null }[], unknown];
    const [colRows] = (await this.conn.query(
      `SELECT table_name AS t, column_name AS c, column_type AS ct,
              is_nullable AS nul, column_key AS ck
         FROM information_schema.columns
        WHERE table_schema = ?
        ORDER BY table_name, ordinal_position`,
      [db],
    )) as [
      { t: string; c: string; ct: string; nul: string; ck: string }[],
      unknown,
    ];
    const [fkRows] = (await this.conn.query(
      `SELECT table_name AS t, column_name AS c,
              referenced_table_name AS rt, referenced_column_name AS rc
         FROM information_schema.key_column_usage
        WHERE table_schema = ? AND referenced_table_name IS NOT NULL`,
      [db],
    )) as [{ t: string; c: string; rt: string; rc: string }[], unknown];

    const fkKey = (t: string, c: string) => `${t}.${c}`;
    const fkMap = new Map(
      fkRows.map((r) => [
        fkKey(r.t, r.c),
        { schema: db, table: r.rt, column: r.rc },
      ]),
    );

    const tableIndex = new Map<string, SchemaTable>();
    const tables: SchemaTable[] = [];
    for (const row of tableRows) {
      const table: SchemaTable = {
        name: row.t,
        type: row.tt === 'VIEW' ? 'view' : 'table',
        columns: [],
        rowEstimate: row.rows_est == null ? undefined : Number(row.rows_est),
      };
      tableIndex.set(row.t, table);
      tables.push(table);
    }
    for (const row of colRows) {
      const column: SchemaColumn = {
        name: row.c,
        dataType: row.ct,
        nullable: row.nul === 'YES',
        isPrimaryKey: row.ck === 'PRI' || undefined,
        references: fkMap.get(fkKey(row.t, row.c)),
      };
      tableIndex.get(row.t)?.columns.push(column);
    }
    return {
      engine: 'mariadb',
      serverVersion: verRows[0]?.v,
      schemas: [{ name: db, tables }],
    };
  }

  async close(): Promise<void> {
    await this.conn.end().catch(() => undefined);
  }
}

function mapMysqlError(err: unknown): BadRequestException {
  const e = err as {
    message?: string;
    code?: string;
    errno?: number;
    sqlState?: string;
  };
  return new BadRequestException({
    statusCode: 400,
    code: 'SQL_ERROR',
    message: e.message ?? 'query failed',
    mysqlCode: e.code,
    sqlState: e.sqlState,
  });
}

@Injectable()
export class MariadbEngineAdapter implements SqlEngineAdapter {
  readonly engine: DbEngine = 'mariadb';

  async connect(params: SqlEngineConnectParams): Promise<SqlEngineConnection> {
    const conn = await createConnection({
      host: params.host,
      port: params.port,
      user: params.credentials.user,
      password: params.credentials.password,
      database: params.credentials.database,
      connectTimeout: 10_000,
      // The single-statement contract is enforced by the copilot; keep the
      // driver strict so a stray multi-statement paste can't slip through.
      multipleStatements: false,
    });
    return new MariadbConnection(conn, params.credentials.database ?? '');
  }
}
