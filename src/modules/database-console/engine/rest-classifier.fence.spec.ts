import { classifyEsRequest } from './raw-rest';
import { classifyMeiliRequest } from './fulltext-engine';

/**
 * F-064 of the September 2026 register.
 *
 * Both raw-REST consoles decided "is this a read" by looking for a known segment
 * ANYWHERE in the path. That is positional-blind: a document whose id is
 * `_search`, or an index named `search`, puts a read word into a write path and
 * walks through the read-only gate.
 */

const post = (path: string) => ({ method: 'POST' as const, path, body: null });

describe('the OpenSearch read/write classifier', () => {
  it.each([
    '/_search',
    '/_msearch',
    '/my-index/_search',
    '/my-index/_count',
    '/logs-2026,logs-2025/_search',
    '/_render/template',
    '/my-index/_search/template',
  ])('reads %s', (path) => {
    expect(classifyEsRequest(post(path))).toBe('read');
  });

  it.each([
    ['/my-index/_doc/_search', 'indexing a document whose id is _search'],
    ['/_scripts/_search', 'storing a script named _search'],
    ['/my-index/_doc/_count', 'the same trick with another read word'],
    ['/_bulk', 'a plain write'],
    ['/my-index/_update_by_query', 'a write that contains "query"'],
    ['/my-index/_doc', 'indexing'],
    ['/_search/scroll/_search', 'a read word twice over'],
  ])('writes %s (%s)', (path) => {
    expect(classifyEsRequest(post(path))).toBe('write');
  });

  it('still lets every safe verb read', () => {
    expect(
      classifyEsRequest({ method: 'GET', path: '/anything', body: null }),
    ).toBe('read');
    expect(
      classifyEsRequest({ method: 'DELETE', path: '/_search', body: null }),
    ).toBe('write');
  });
});

describe('the Meilisearch read/write classifier', () => {
  it.each([
    '/multi-search',
    '/indexes/products/search',
    '/indexes/products/facet-search',
  ])('reads %s', (path) => {
    expect(classifyMeiliRequest(post(path))).toBe('read');
  });

  it.each([
    [
      '/indexes/search/documents',
      'adding documents to an index named "search"',
    ],
    ['/indexes/multi-search/documents', 'the same with the other read word'],
    ['/indexes', 'creating an index'],
    ['/indexes/products/documents', 'a plain write'],
    ['/dumps', 'a dump'],
  ])('writes %s (%s)', (path) => {
    expect(classifyMeiliRequest(post(path))).toBe('write');
  });
});
