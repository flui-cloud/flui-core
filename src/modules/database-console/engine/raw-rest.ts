import { SearchEngine } from './search-engine';

/**
 * Engine-neutral raw REST passthrough. A "Dev Tools"-style console (Kibana /
 * OpenSearch Dashboards) lets an operator run native REST calls against the
 * store. The transport (resolve + port-forward + audit) and the frontend shell
 * are generic; each engine only supplies a request classifier so the read-only
 * gate knows which calls mutate. Today: OpenSearch / ES-wire; a future REST
 * store plugs in by adding a profile + classifier.
 */
export type RawRestMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'HEAD'
  | 'PATCH';

export interface RawRestRequest {
  method: RawRestMethod;
  /** Path under the store's REST root, e.g. /_cat/indices or /products/_search. */
  path: string;
  /** Optional JSON body (or NDJSON string for _bulk). */
  body?: unknown;
}

export interface RawRestResponse {
  status: number;
  durationMs: number;
  body: unknown;
}

/** A request is a `read` (safe under read-only) or a `write` (mutates data/settings). */
export type RestRequestKind = 'read' | 'write';

export type RestRequestClassifier = (req: RawRestRequest) => RestRequestKind;

// POST is overloaded in ES-wire: query endpoints read, everything else writes.
// Match these as a path segment so /products/_search and /_search both count.
const ES_READ_POST = [
  '_search',
  '_count',
  '_msearch',
  '_field_caps',
  '_analyze',
  '_explain',
  '_validate',
  '_mget',
  '_terms_enum',
  '_render',
  '_search_shards',
];

function pathHasSegment(path: string, segments: string[]): boolean {
  const clean = path.split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  return parts.some((p) => segments.includes(p));
}

/**
 * ES-wire (OpenSearch / Elasticsearch) classifier. GET/HEAD never mutate; PUT/
 * DELETE/PATCH always do; POST reads only for the known query endpoints and is
 * treated as a write otherwise (safe default — unknown POSTs stay gated).
 */
export const classifyEsRequest: RestRequestClassifier = (req) => {
  if (req.method === 'GET' || req.method === 'HEAD') return 'read';
  if (req.method === 'POST') {
    return pathHasSegment(req.path, ES_READ_POST) ? 'read' : 'write';
  }
  return 'write';
};

export const REST_CLASSIFIERS: Record<SearchEngine, RestRequestClassifier> = {
  opensearch: classifyEsRequest,
};
