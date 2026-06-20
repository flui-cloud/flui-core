import { DbCredentials, DbEngine } from '../interfaces/db-connection';

/** A database listed in the browser: name + on-disk size (server metadata, not data). */
export interface DocumentDatabase {
  name: string;
  sizeOnDisk?: number;
  empty?: boolean;
}

/** A collection (or view) within a database + an estimated document count (metadata only). */
export interface DocumentCollection {
  name: string;
  type: 'collection' | 'view';
  /** Fast metadata estimate (collection stats), not an exact scan. */
  estimatedCount?: number;
}

// Data-blind store overview: counts only, never database/collection contents.
export interface DocumentStoreSummary {
  databaseCount: number;
  databases: { name: string; collectionCount: number }[];
}

/** A page of documents from one collection — this carries data (owner-only browse). */
export interface DocumentPage {
  documents: unknown[];
  /** How many documents were returned (≤ limit). */
  count: number;
  /** True when more documents matched than the page limit. */
  truncated: boolean;
  durationMs: number;
}

export interface DocumentFindOptions {
  /** Mongo query filter document; {} matches all. */
  filter?: Record<string, unknown>;
  /** Mongo sort document, e.g. { createdAt: -1 }. */
  sort?: Record<string, 1 | -1>;
  /** Field projection, e.g. { _id: 0, name: 1 }. */
  projection?: Record<string, 0 | 1>;
  limit: number;
  skip: number;
}

export interface CommandResult {
  reply: unknown;
  durationMs: number;
}

/**
 * Result of a mongosh-shell statement: the raw command reply (Extended JSON) plus
 * how the dashboard should render it (cursor → docs, count → number, …) and whether
 * it was a write. The translation lives in mongo-shell.ts; the command itself runs
 * through the same read-only-gated path as `command`.
 */
export interface ShellResult {
  /** Database the command ran against. */
  database: string;
  /** Mongo command name (find, insert, …). */
  method: string;
  /** Render hint for the transcript. */
  shape: string;
  /** True when the statement was a write/mutation. */
  mutation: boolean;
  /** The command reply, canonical Extended JSON (same serialization as `command`). */
  reply: unknown;
  durationMs: number;
}

/** An inferred field of a collection (schemaless store) — a dotted path + the BSON types seen at it. */
export interface DocumentField {
  /** Dotted path, e.g. "name", "dimensions.w", "rows.sub.flag". */
  path: string;
  /** Distinct BSON/JS types observed at this path across the sample. */
  types: string[];
}

export interface DocumentFieldsOptions {
  /** Random-sample size drawn across the whole collection (anti-clustering). */
  sampleSize: number;
  /** Extra newest-by-_id docs unioned in, so recent schema additions are always captured. */
  recent: number;
}

export interface DocumentConnectParams {
  host: string;
  port: number;
  credentials: DbCredentials;
}

/** A live session against one document store. Owns the underlying client connection. */
export interface DocumentConnection {
  summary(): Promise<DocumentStoreSummary>;
  databases(): Promise<DocumentDatabase[]>;
  collections(database: string): Promise<DocumentCollection[]>;
  find(
    database: string,
    collection: string,
    opts: DocumentFindOptions,
  ): Promise<DocumentPage>;
  command(
    database: string,
    command: Record<string, unknown>,
    opts: { readOnly: boolean },
  ): Promise<CommandResult>;
  /** Infer the field structure of a collection by sampling (for query autocomplete). */
  fields(
    database: string,
    collection: string,
    opts: DocumentFieldsOptions,
  ): Promise<DocumentField[]>;
  close(): Promise<void>;
}

/**
 * Per-engine document adapter. One implementation can serve several wire-compatible engines
 * (the Mongo-wire adapter covers FerretDB today and a future real MongoDB), so `engines` is a
 * list — mirrors how RedisEngineAdapter serves both 'redis' and 'valkey'.
 */
export interface DocumentEngineAdapter {
  readonly engines: DbEngine[];
  connect(params: DocumentConnectParams): Promise<DocumentConnection>;
}

/** DI token for the set of available document engine adapters. */
export const DOCUMENT_ENGINE_ADAPTERS = Symbol('DOCUMENT_ENGINE_ADAPTERS');
