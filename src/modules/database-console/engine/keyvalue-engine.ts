import { DbCredentials, DbEngine } from '../interfaces/db-connection';

export type KeyType =
  | 'string'
  | 'list'
  | 'set'
  | 'zset'
  | 'hash'
  | 'stream'
  | 'none';

/** A key listed in the browser: name + type + TTL seconds (-1 no expire, -2 missing). */
export interface KeyMeta {
  key: string;
  type: KeyType;
  ttl: number;
}

export interface ScanResult {
  /** Opaque SCAN cursor; '0' means iteration complete. */
  cursor: string;
  keys: KeyMeta[];
}

// Data-blind keyspace overview: counts only, never key names or values.
export interface KeyspaceSummary {
  keyCount: number;
  /** How many keys were sampled to estimate the type breakdown. */
  sampled: number;
  byType: { type: KeyType; count: number }[];
}

export interface KvStringValue {
  kind: 'string';
  value: string;
}
export interface KvHashValue {
  kind: 'hash';
  fields: { field: string; value: string }[];
}
export interface KvListValue {
  kind: 'list';
  items: string[];
}
export interface KvSetValue {
  kind: 'set';
  members: string[];
}
export interface KvZSetValue {
  kind: 'zset';
  entries: { member: string; score: number }[];
}
export interface KvOtherValue {
  kind: 'other';
  note: string;
}
export type KvValue =
  | KvStringValue
  | KvHashValue
  | KvListValue
  | KvSetValue
  | KvZSetValue
  | KvOtherValue;

export interface KeyValueRead {
  key: string;
  type: KeyType;
  ttl: number;
  /** Element count for collections (hash fields, list/set/zset members). */
  length?: number;
  /** True when the value was capped at maxElements. */
  truncated: boolean;
  value: KvValue;
}

export interface CommandResult {
  reply: unknown;
  durationMs: number;
}

export interface KvConnectParams {
  host: string;
  port: number;
  credentials: DbCredentials;
}

/** A live session against one key-value server. Owns the underlying client connection. */
export interface KeyValueConnection {
  summary(): Promise<KeyspaceSummary>;
  scan(opts: {
    cursor: string;
    match?: string;
    count: number;
  }): Promise<ScanResult>;
  readKey(key: string, opts: { maxElements: number }): Promise<KeyValueRead>;
  command(
    args: (string | number)[],
    opts: { readOnly: boolean },
  ): Promise<CommandResult>;
  close(): Promise<void>;
}

/**
 * Per-engine key-value adapter. One implementation can serve several wire-compatible engines
 * (RedisEngineAdapter covers both 'redis' and 'valkey'), so `engines` is a list.
 */
export interface KeyValueEngineAdapter {
  readonly engines: DbEngine[];
  connect(params: KvConnectParams): Promise<KeyValueConnection>;
}

/** DI token for the set of available key-value engine adapters. */
export const KV_ENGINE_ADAPTERS = Symbol('KV_ENGINE_ADAPTERS');
