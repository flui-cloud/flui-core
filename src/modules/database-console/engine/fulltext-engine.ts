import { RawRestRequest, RestRequestClassifier } from './raw-rest';

/**
 * Full-text search family. Meilisearch today — a REST search engine whose API is
 * NOT Elasticsearch-wire (no query-DSL, no shards/health; indexes are flat with a
 * primary key, search is `{q, filter, limit}`), so it gets its own family instead
 * of being forced into the ES-shaped `search` contract.
 */
export type FulltextEngine = 'meilisearch';

export interface FulltextServerInfo {
  version: string;
  /** Total on-disk size in bytes, when the engine reports it. */
  databaseSize?: number;
  indexCount: number;
}

export interface FulltextIndex {
  uid: string;
  primaryKey?: string;
  numberOfDocuments?: number;
}

export interface FulltextHit {
  /** The document, verbatim. */
  document: Record<string, unknown>;
}

export interface FulltextSearchResult {
  query: string;
  hits: Record<string, unknown>[];
  estimatedTotalHits: number;
  processingTimeMs: number;
  limit: number;
  offset: number;
}

export interface FulltextSearchParams {
  q?: string;
  /** Engine filter expression (e.g. `genre = horror AND rating > 4`). */
  filter?: string;
  limit?: number;
  offset?: number;
}

export interface FulltextConnectParams {
  host: string;
  port: number;
  /** Master/API key — sent as a Bearer token. */
  apiKey?: string;
}

/** A live session against one full-text engine. */
export interface FulltextConnection {
  serverInfo(): Promise<FulltextServerInfo>;
  listIndexes(): Promise<FulltextIndex[]>;
  search(
    index: string,
    params: FulltextSearchParams,
  ): Promise<FulltextSearchResult>;
  /** Raw REST passthrough for the Dev Tools console (read-only gate runs upstream). */
  raw(
    req: RawRestRequest,
  ): Promise<{ status: number; durationMs: number; body: unknown }>;
  close(): Promise<void>;
}

export interface FulltextEngineAdapter {
  readonly engines: FulltextEngine[];
  connect(params: FulltextConnectParams): Promise<FulltextConnection>;
}

export const FULLTEXT_ENGINE_ADAPTERS = Symbol('FULLTEXT_ENGINE_ADAPTERS');

export interface FulltextAuthProfile {
  /** Secret key(s) holding the master/API key; first present wins. */
  keySecretKeys: string[];
}

export interface FulltextProfile {
  engine: FulltextEngine;
  label: string;
  httpPort: number;
  imagePattern: RegExp;
  auth: FulltextAuthProfile;
}

export const FULLTEXT_PROFILES: Record<FulltextEngine, FulltextProfile> = {
  meilisearch: {
    engine: 'meilisearch',
    label: 'Meilisearch',
    httpPort: 7700,
    imagePattern: /meilisearch|getmeili/i,
    auth: { keySecretKeys: ['MEILI_MASTER_KEY'] },
  },
};

export function detectFulltextEngine(imageRef?: string): FulltextEngine | null {
  if (!imageRef) return null;
  for (const profile of Object.values(FULLTEXT_PROFILES)) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}

// Meilisearch is REST: GET/HEAD read; POST is a write EXCEPT the search endpoints
// (/indexes/{uid}/search, /multi-search) which read; PUT/PATCH/DELETE always write.
const MEILI_READ_POST = ['search', 'multi-search', 'facet-search'];

function pathHasSegment(path: string, segments: string[]): boolean {
  const clean = path.split('?')[0];
  return clean
    .split('/')
    .filter(Boolean)
    .some((p) => segments.includes(p));
}

export const classifyMeiliRequest: RestRequestClassifier = (
  req: RawRestRequest,
) => {
  if (req.method === 'GET' || req.method === 'HEAD') return 'read';
  if (req.method === 'POST') {
    return pathHasSegment(req.path, MEILI_READ_POST) ? 'read' : 'write';
  }
  return 'write';
};

export const FULLTEXT_CLASSIFIERS: Record<
  FulltextEngine,
  RestRequestClassifier
> = {
  meilisearch: classifyMeiliRequest,
};
