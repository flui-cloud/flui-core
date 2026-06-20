import { classifyMeiliRequest, detectFulltextEngine } from './fulltext-engine';

describe('fulltext engine (Meilisearch)', () => {
  describe('detectFulltextEngine', () => {
    it('matches the official image refs', () => {
      expect(detectFulltextEngine('getmeili/meilisearch:v1')).toBe(
        'meilisearch',
      );
      expect(detectFulltextEngine('docker.io/getmeili/meilisearch:v1.7')).toBe(
        'meilisearch',
      );
      expect(detectFulltextEngine('meilisearch:latest')).toBe('meilisearch');
    });
    it('ignores unrelated images', () => {
      expect(detectFulltextEngine('opensearchproject/opensearch:2')).toBeNull();
      expect(detectFulltextEngine(undefined)).toBeNull();
    });
  });

  describe('classifyMeiliRequest (read-only gate)', () => {
    it('treats GET/HEAD as reads', () => {
      expect(classifyMeiliRequest({ method: 'GET', path: '/indexes' })).toBe(
        'read',
      );
      expect(classifyMeiliRequest({ method: 'GET', path: '/stats' })).toBe(
        'read',
      );
      expect(classifyMeiliRequest({ method: 'HEAD', path: '/health' })).toBe(
        'read',
      );
    });
    it('treats the search endpoints as reads even though they are POST', () => {
      expect(
        classifyMeiliRequest({
          method: 'POST',
          path: '/indexes/movies/search',
        }),
      ).toBe('read');
      expect(
        classifyMeiliRequest({ method: 'POST', path: '/multi-search' }),
      ).toBe('read');
      expect(
        classifyMeiliRequest({
          method: 'POST',
          path: '/indexes/movies/facet-search',
        }),
      ).toBe('read');
    });
    it('treats other POST/PUT/PATCH/DELETE as writes', () => {
      expect(classifyMeiliRequest({ method: 'POST', path: '/indexes' })).toBe(
        'write',
      );
      expect(
        classifyMeiliRequest({
          method: 'POST',
          path: '/indexes/movies/documents',
        }),
      ).toBe('write');
      expect(
        classifyMeiliRequest({
          method: 'PUT',
          path: '/indexes/movies/documents',
        }),
      ).toBe('write');
      expect(
        classifyMeiliRequest({
          method: 'PATCH',
          path: '/indexes/movies/settings',
        }),
      ).toBe('write');
      expect(
        classifyMeiliRequest({ method: 'DELETE', path: '/indexes/movies' }),
      ).toBe('write');
    });
    it('ignores query strings when matching the segment', () => {
      expect(
        classifyMeiliRequest({
          method: 'POST',
          path: '/indexes/movies/search?x=1',
        }),
      ).toBe('read');
    });
  });
});
