/**
 * Cache engine family. Memcached today — a flat, volatile key/value cache spoken
 * over its ASCII protocol. Deliberately NOT the key-value (Redis) family: the
 * protocol is different and Memcached cannot reliably enumerate keys, so the
 * console is stats + exact-key get/set/delete rather than a key browser.
 */
export type CacheEngine = 'memcached';

export interface CacheServerInfo {
  version: string;
  uptimeSeconds: number;
  /** Items currently stored. */
  currItems: number;
  /** Items ever stored since start. */
  totalItems: number;
  /** Bytes currently used by stored items. */
  bytes: number;
  /** Configured max bytes (the cache size). */
  limitMaxBytes: number;
  getHits: number;
  getMisses: number;
  evictions: number;
  currConnections: number;
  totalConnections: number;
  cmdGet: number;
  cmdSet: number;
  bytesRead: number;
  bytesWritten: number;
}

/**
 * One stored item. `value` is the UTF-8 decoding when textual; binary values
 * come back base64 with `encoding: 'base64'`.
 */
export interface CacheEntry {
  key: string;
  value: string;
  encoding: 'utf8' | 'base64';
  /** Opaque client flags stored alongside the value. */
  flags: number;
  sizeBytes: number;
}

export interface CacheSetInput {
  key: string;
  value: string;
  /** Seconds until expiry; 0 (default) never expires. */
  ttlSeconds?: number;
  flags?: number;
}

export interface CacheConnectParams {
  host: string;
  port: number;
}

/** A live session against one cache server. */
export interface CacheConnection {
  serverInfo(): Promise<CacheServerInfo>;
  /** Fetch one item by exact key, or null when absent. */
  get(key: string): Promise<CacheEntry | null>;
  set(input: CacheSetInput): Promise<void>;
  /** Returns true if the key existed and was removed. */
  delete(key: string): Promise<boolean>;
  /** Invalidate the entire cache. */
  flushAll(): Promise<void>;
  close(): Promise<void>;
}

export interface CacheEngineAdapter {
  readonly engines: CacheEngine[];
  connect(params: CacheConnectParams): Promise<CacheConnection>;
}

export const CACHE_ENGINE_ADAPTERS = Symbol('CACHE_ENGINE_ADAPTERS');

export interface CacheProfile {
  engine: CacheEngine;
  label: string;
  /** In-cluster client port. */
  port: number;
  imagePattern: RegExp;
}

export const CACHE_PROFILES: Record<CacheEngine, CacheProfile> = {
  memcached: {
    engine: 'memcached',
    label: 'Memcached',
    port: 11211,
    imagePattern: /memcached/i,
  },
};

export function detectCacheEngine(imageRef?: string): CacheEngine | null {
  if (!imageRef) return null;
  for (const profile of Object.values(CACHE_PROFILES)) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}
