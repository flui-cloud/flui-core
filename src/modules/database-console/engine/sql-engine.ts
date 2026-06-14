import { DbCredentials, DbEngine } from '../interfaces/db-connection';

export interface SqlQueryOptions {
  readOnly: boolean;
  statementTimeoutMs: number;
  maxRows: number;
}

export interface SqlColumn {
  name: string;
  dataType: string;
}

export interface SqlQueryResult {
  command: string;
  columns: SqlColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface SchemaColumnRef {
  schema: string;
  table: string;
  column: string;
}

export interface SchemaColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey?: boolean;
  /** Set when this column is a foreign key pointing at another column. */
  references?: SchemaColumnRef;
}

export interface SchemaTable {
  name: string;
  type: 'table' | 'view';
  columns: SchemaColumn[];
  /** Planner estimate (pg_class.reltuples); -1/undefined when never analyzed. */
  rowEstimate?: number;
}

export interface SchemaNamespace {
  name: string;
  tables: SchemaTable[];
}

export interface SchemaTree {
  /** Which engine produced this tree — grounds the copilot dialect + UI. */
  engine: DbEngine;
  schemas: SchemaNamespace[];
  /** Live server version (e.g. "16.2"), used to ground the copilot. Server metadata, not data. */
  serverVersion?: string;
}

/** A live session against one database. Owns the underlying driver connection. */
export interface SqlEngineConnection {
  query(sql: string, opts: SqlQueryOptions): Promise<SqlQueryResult>;
  introspect(): Promise<SchemaTree>;
  close(): Promise<void>;
}

export interface SqlEngineConnectParams {
  host: string;
  port: number;
  credentials: DbCredentials;
}

/**
 * Per-engine driver adapter. Each SQL engine ships one implementation behind this
 * interface; the query layer never branches on the engine, it looks the adapter up by
 * `engine` from the registry below.
 */
export interface SqlEngineAdapter {
  readonly engine: DbEngine;
  connect(params: SqlEngineConnectParams): Promise<SqlEngineConnection>;
}

/**
 * DI token for the set of available SQL engine adapters. Registering a new SQL engine =
 * add its adapter to this multi-provider array in the module; no consumer code changes.
 */
export const SQL_ENGINE_ADAPTERS = Symbol('SQL_ENGINE_ADAPTERS');
