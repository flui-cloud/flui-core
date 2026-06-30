import { FuzzyCandidate, rankBySimilarity } from './catalog-fuzzy.util';

const CATALOG: FuzzyCandidate[] = [
  {
    slug: 'flui-demo-activity',
    name: 'Flui Live Activity (demo)',
    description: 'Reactive Postgres -> NATS -> Redis -> SSE reference app',
    tags: ['demo', 'reactive'],
  },
  { slug: 'postgresql', name: 'PostgreSQL', tags: ['database'] },
  { slug: 'redis', name: 'Redis', tags: ['cache'] },
  { slug: 'nextcloud', name: 'Nextcloud', tags: ['files'] },
];

describe('rankBySimilarity', () => {
  it('finds "Flui Live Activity (demo)" from the phrasing that misses a substring LIKE', () => {
    const hits = rankBySimilarity('Flui Live Activity app', CATALOG);
    expect(hits[0]?.slug).toBe('flui-demo-activity');
  });

  it('recovers the real slug from a plausible wrong guess', () => {
    const hits = rankBySimilarity('flui-live-activity', CATALOG);
    expect(hits[0]?.slug).toBe('flui-demo-activity');
  });

  it('tolerates a typo on a single-word query', () => {
    const hits = rankBySimilarity('postgre', CATALOG);
    expect(hits.map((h) => h.slug)).toContain('postgresql');
  });

  it('returns nothing for an unrelated query', () => {
    expect(rankBySimilarity('kubernetes dashboard xyz', CATALOG)).toHaveLength(
      0,
    );
  });

  it('caps the number of suggestions', () => {
    const hits = rankBySimilarity('e', CATALOG, 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
