import { BadRequestException, Injectable } from '@nestjs/common';
import { Client, type FieldDef } from 'pg';
import { DbEngine } from '../interfaces/db-connection';
import {
  SchemaTable,
  SchemaTree,
  SqlEngineAdapter,
  SqlEngineConnectParams,
  SqlEngineConnection,
  SqlQueryOptions,
  SqlQueryResult,
} from './sql-engine';

// Minimal OID -> friendly name map for the common types; unknowns fall back to
// `oid:<n>` rather than pulling the full pg_type catalog per query.
const PG_TYPE_NAMES: Record<number, string> = {
  16: 'bool',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  700: 'float4',
  701: 'float8',
  1043: 'varchar',
  1700: 'numeric',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  114: 'json',
  3802: 'jsonb',
  2950: 'uuid',
};

function pgTypeName(oid: number): string {
  return PG_TYPE_NAMES[oid] ?? `oid:${oid}`;
}

interface PgQueryResultLike {
  command?: string;
  rows?: unknown[][];
  fields?: FieldDef[];
  // Driver-reported count: rows affected for writes, rows returned for SELECT.
  rowCount?: number | null;
}

class PostgresConnection implements SqlEngineConnection {
  constructor(private readonly client: Client) {}

  async query(sql: string, opts: SqlQueryOptions): Promise<SqlQueryResult> {
    const start = Date.now();
    await this.client.query('BEGIN');
    try {
      if (opts.readOnly) {
        await this.client.query('SET TRANSACTION READ ONLY');
      }
      await this.client.query(
        `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.statementTimeoutMs))}`,
      );
      const raw = (await this.client.query({
        text: sql,
        rowMode: 'array',
      })) as unknown;
      // Multiple statements in one request yield an array of results; surface
      // the last one in the grid (multi-result tabs are a future enhancement).
      const result: PgQueryResultLike = Array.isArray(raw)
        ? (raw.at(-1) as PgQueryResultLike)
        : (raw as PgQueryResultLike);

      // Read-only sessions never persist; writes (future per-user roles) commit.
      await this.client.query(opts.readOnly ? 'ROLLBACK' : 'COMMIT');

      const allRows = result.rows ?? [];
      const truncated = allRows.length > opts.maxRows;
      const rows = truncated ? allRows.slice(0, opts.maxRows) : allRows;
      // Writes (INSERT/UPDATE/DELETE) return no rows but set the driver rowCount to
      // the affected count — surface that so the grid header doesn't read "0 rows".
      const rowCount =
        typeof result.rowCount === 'number' ? result.rowCount : allRows.length;
      return {
        command: result.command ?? '',
        columns: (result.fields ?? []).map((f) => ({
          name: f.name,
          dataType: pgTypeName(f.dataTypeID),
        })),
        rows,
        rowCount,
        truncated,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw mapPgError(err);
    }
  }

  async introspect(): Promise<SchemaTree> {
    const versionRes = await this.client.query<{ server_version: string }>(
      'SHOW server_version',
    );
    const tablesRes = await this.client.query<{
      table_schema: string;
      table_name: string;
      table_type: string;
    }>(
      `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name`,
    );
    const columnsRes = await this.client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position`,
    );
    const pkRes = await this.client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    const fkRes = await this.client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      foreign_schema: string;
      foreign_table: string;
      foreign_column: string;
    }>(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name,
              ccu.table_schema AS foreign_schema,
              ccu.table_name   AS foreign_table,
              ccu.column_name  AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.constraint_schema = tc.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    const estRes = await this.client.query<{
      table_schema: string;
      table_name: string;
      estimate: string;
    }>(
      `SELECT n.nspname AS table_schema, c.relname AS table_name,
              c.reltuples::bigint AS estimate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
    );

    const tableKey = (s: string, t: string) => `${s}.${t}`;
    const colKey = (s: string, t: string, c: string) => `${s}.${t}.${c}`;

    const pkSet = new Set(
      pkRes.rows.map((r) =>
        colKey(r.table_schema, r.table_name, r.column_name),
      ),
    );
    const fkMap = new Map(
      fkRes.rows.map((r) => [
        colKey(r.table_schema, r.table_name, r.column_name),
        {
          schema: r.foreign_schema,
          table: r.foreign_table,
          column: r.foreign_column,
        },
      ]),
    );
    const estMap = new Map(
      estRes.rows.map((r) => [
        tableKey(r.table_schema, r.table_name),
        Number(r.estimate),
      ]),
    );

    const tableIndex = new Map<string, SchemaTable>();
    const schemaMap = new Map<string, SchemaTable[]>();
    for (const row of tablesRes.rows) {
      const est = estMap.get(tableKey(row.table_schema, row.table_name));
      const table: SchemaTable = {
        name: row.table_name,
        type: row.table_type === 'VIEW' ? 'view' : 'table',
        columns: [],
        rowEstimate: est !== undefined && est >= 0 ? est : undefined,
      };
      tableIndex.set(tableKey(row.table_schema, row.table_name), table);
      const list = schemaMap.get(row.table_schema) ?? [];
      list.push(table);
      schemaMap.set(row.table_schema, list);
    }
    for (const row of columnsRes.rows) {
      const table = tableIndex.get(tableKey(row.table_schema, row.table_name));
      const key = colKey(row.table_schema, row.table_name, row.column_name);
      table?.columns.push({
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable === 'YES',
        isPrimaryKey: pkSet.has(key) || undefined,
        references: fkMap.get(key),
      });
    }
    return {
      engine: 'postgres',
      serverVersion: versionRes.rows[0]?.server_version,
      schemas: [...schemaMap.entries()].map(([name, tables]) => ({
        name,
        tables,
      })),
    };
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}

function mapPgError(err: unknown): BadRequestException {
  const e = err as { message?: string; position?: string; code?: string };
  return new BadRequestException({
    statusCode: 400,
    code: 'SQL_ERROR',
    message: e.message ?? 'query failed',
    pgCode: e.code,
    position: e.position ? Number(e.position) : undefined,
  });
}

@Injectable()
export class PostgresEngineAdapter implements SqlEngineAdapter {
  readonly engine: DbEngine = 'postgres';

  async connect(params: SqlEngineConnectParams): Promise<SqlEngineConnection> {
    const client = new Client({
      host: params.host,
      port: params.port,
      user: params.credentials.user,
      password: params.credentials.password,
      database: params.credentials.database,
      ssl: false,
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    return new PostgresConnection(client);
  }
}
