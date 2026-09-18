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

/**
 * The POST paths that read, written as whole shapes rather than as a set of
 * segments to look for anywhere.
 *
 * "Anywhere" was the defect. `POST /idx/_doc/_search` indexes a document whose
 * id happens to be `_search`, and `POST /_scripts/_search` stores a script under
 * that name — both contain a segment from the read list, both mutate, and both
 * were classified as reads and let through the read-only gate. Matching only the
 * last segment does not fix it either, since it is the last segment in both.
 *
 * What actually distinguishes them is the shape: a query endpoint is the action
 * alone, or an index followed by the action. An index name cannot begin with an
 * underscore (the server reserves that prefix), which is what makes the first
 * segment safe to allow as a wildcard here.
 */
const ES_READ_ACTION =
  '(_search|_count|_msearch|_field_caps|_analyze|_explain|_validate|_mget|_terms_enum|_search_shards)';

const ES_READ_POST_SHAPES = [
  // /_search, /_msearch, …
  new RegExp(`^${ES_READ_ACTION}$`),
  // /my-index/_search, /my-index,other/_count, … — never /_scripts/_search,
  // because an index may not start with an underscore.
  new RegExp(`^[^_/][^/]*/${ES_READ_ACTION}$`),
  // The template forms, which carry one more segment.
  /^_render\/template$/,
  /^(_search|[^_/][^/]*\/_search)\/template$/,
];

function esReadPath(path: string): boolean {
  const clean = path.split('?')[0].split('/').filter(Boolean).join('/');
  return ES_READ_POST_SHAPES.some((shape) => shape.test(clean));
}

/**
 * ES-wire (OpenSearch / Elasticsearch) classifier. GET/HEAD never mutate; PUT/
 * DELETE/PATCH always do; POST reads only for the known query shapes and is
 * treated as a write otherwise (safe default — unknown POSTs stay gated).
 */
export const classifyEsRequest: RestRequestClassifier = (req) => {
  if (req.method === 'GET' || req.method === 'HEAD') return 'read';
  if (req.method === 'POST') return esReadPath(req.path) ? 'read' : 'write';
  return 'write';
};

export const REST_CLASSIFIERS: Record<SearchEngine, RestRequestClassifier> = {
  opensearch: classifyEsRequest,
};
