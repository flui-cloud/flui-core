import { RawRestRequest, RawRestResponse } from './raw-rest';

/**
 * Search engine family. OpenSearch today; the adapter speaks the Elasticsearch
 * REST wire, so a future real Elasticsearch (or any ES-wire store) is one
 * profile entry away.
 */
export type SearchEngine = 'opensearch';

export interface SearchClusterInfo {
  clusterName: string;
  version: string;
  distribution?: string;
}

export interface SearchIndex {
  name: string;
  health?: string;
  status?: string;
  docsCount?: number;
  storeSize?: string;
  uuid?: string;
}

export interface SearchHit {
  id: string;
  index: string;
  score: number | null;
  source: Record<string, unknown>;
}

export interface SearchResponse {
  /** Total matching docs (may be a lower bound when tracked relation is "gte"). */
  total: number;
  totalRelation: 'eq' | 'gte';
  maxScore: number | null;
  tookMs: number;
  timedOut: boolean;
  hits: SearchHit[];
}

export interface SearchConnectParams {
  host: string;
  port: number;
  username: string;
  password: string;
  useTls: boolean;
}

/** A live, read-only session against one search cluster. */
export interface SearchConnection {
  clusterInfo(): Promise<SearchClusterInfo>;
  listIndices(): Promise<SearchIndex[]>;
  getMapping(index: string): Promise<Record<string, unknown>>;
  /** Run a query-DSL body against _search; from/size paginate. */
  search(
    index: string,
    body: Record<string, unknown>,
    opts: { from: number; size: number },
  ): Promise<SearchResponse>;
  count(index: string, body?: Record<string, unknown>): Promise<number>;
  /**
   * Raw REST passthrough for the Dev Tools console. Returns the store's status
   * and JSON body verbatim (including 4xx/5xx error bodies) — the read-only gate
   * is enforced upstream, not here.
   */
  raw(req: RawRestRequest): Promise<RawRestResponse>;
  close(): Promise<void>;
}

export interface SearchEngineAdapter {
  readonly engines: SearchEngine[];
  connect(params: SearchConnectParams): Promise<SearchConnection>;
}

export const SEARCH_ENGINE_ADAPTERS = Symbol('SEARCH_ENGINE_ADAPTERS');

export interface SearchProfile {
  engine: SearchEngine;
  label: string;
  /** In-cluster REST API port. */
  httpPort: number;
  /** Security plugin serves HTTPS with a self-signed cert by default. */
  useTls: boolean;
  /** Fixed admin user (OpenSearch has no user env — the password is generated). */
  adminUser: string;
  /** Secret keys (first present wins) holding the admin password. */
  passwordSecretKeys: string[];
  imagePattern: RegExp;
}

export const SEARCH_PROFILES: Record<SearchEngine, SearchProfile> = {
  opensearch: {
    engine: 'opensearch',
    label: 'OpenSearch',
    httpPort: 9200,
    useTls: true,
    adminUser: 'admin',
    passwordSecretKeys: ['OPENSEARCH_INITIAL_ADMIN_PASSWORD'],
    imagePattern: /opensearch/i,
  },
};

export function detectSearchEngine(imageRef?: string): SearchEngine | null {
  if (!imageRef) return null;
  for (const profile of Object.values(SEARCH_PROFILES)) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}
