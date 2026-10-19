import { KnowledgeService } from './knowledge.service';

describe('KnowledgeService.docLinksFor', () => {
  const service = new KnowledgeService();

  it('maps a concept id to its docs.flui.cloud route (numeric prefix kept)', () => {
    expect(service.docLinksFor(['concepts/03-cluster-as-a-concept'])).toEqual([
      {
        title: 'The cluster as a concept',
        url: 'https://docs.flui.cloud/concepts/03-cluster-as-a-concept/',
      },
    ]);
  });

  it('maps a cli id and collapses /index to the directory root', () => {
    expect(
      service.docLinksFor(['cli/clusters-and-nodes', 'cli/index']),
    ).toEqual([
      {
        title: 'Clusters and nodes',
        url: 'https://docs.flui.cloud/cli/clusters-and-nodes/',
      },
      { title: 'CLI Reference', url: 'https://docs.flui.cloud/cli/' },
    ]);
  });

  it('skips sections without a published page (generated reference, schema)', () => {
    // cli/reference is sourced from oclif-manifest, flui-manifest/schema from flui-spec
    expect(
      service.docLinksFor(['cli/reference', 'flui-manifest/schema']),
    ).toEqual([]);
  });

  it('dedupes and caps the number of links', () => {
    const ids = [
      'concepts/00-what-is-flui',
      'concepts/00-what-is-flui',
      'concepts/01-flui-vs-provider-layer',
      'concepts/02-why-k3s',
      'concepts/03-cluster-as-a-concept',
    ];
    const links = service.docLinksFor(ids);
    expect(links.length).toBe(3);
    expect(new Set(links.map((l) => l.url)).size).toBe(3);
  });

  it('returns nothing for empty, unknown, or undefined input', () => {
    expect(service.docLinksFor()).toEqual([]);
    expect(service.docLinksFor([])).toEqual([]);
    expect(service.docLinksFor(['does/not-exist'])).toEqual([]);
  });
});

describe('KnowledgeService.selectSections', () => {
  const service = new KnowledgeService();

  it('keeps the known ids the router chose, at most four, without duplicates', () => {
    expect(
      service.selectSections(
        [
          'cli/backups',
          'not/a-section',
          'cli/backups',
          'cli/databases',
          'cli/deploy',
          'cli/environments',
          'cli/applications',
        ],
        'anything',
      ),
    ).toEqual({
      sectionIds: [
        'cli/backups',
        'cli/databases',
        'cli/deploy',
        'cli/environments',
      ],
      via: 'router',
    });
  });

  it('matches the question against titles when the router gave nothing usable', () => {
    const pick = service.selectSections(
      ['not/a-section'],
      'How do I configure firewalls for my cluster?',
    );
    expect(pick.via).toBe('lexical');
    expect(pick.sectionIds).toContain('concepts/12-firewalls');
    expect(pick.sectionIds.length).toBeLessThanOrEqual(3);
  });

  it('finds the backup pages for a backup question', () => {
    const pick = service.selectSections([], 'how are backups restored?');
    expect(pick.via).toBe('lexical');
    expect(pick.sectionIds).toContain('cli/backups');
  });

  it('never picks the generated CLI reference as a fallback', () => {
    expect(service.lexicalMatch('cli reference command flags')).not.toContain(
      'cli/reference',
    );
  });

  it('falls back to the introduction only when nothing matches', () => {
    expect(service.selectSections([], 'ciao?')).toEqual({
      sectionIds: ['concepts/00-what-is-flui'],
      via: 'fallback',
    });
  });
});

describe('KnowledgeService.getSystemContext', () => {
  const service = new KnowledgeService();

  it('labels each section in plain words, never with a host-like source id', () => {
    const context = service.getSystemContext([
      'concepts/03-cluster-as-a-concept',
      'cli/reference',
      'flui-manifest/schema',
    ]);
    expect(context).toContain(
      '## The cluster as a concept\n_(Flui documentation)_',
    );
    expect(context).toContain('_(CLI reference)_');
    expect(context).toContain('_(flui.yaml specification)_');
    expect(context).not.toMatch(/source: |flui-docs|oclif-manifest|flui-spec/);
  });
});

describe('KnowledgeService prompt order for the provider cache', () => {
  const service = new KnowledgeService();
  const stable = '# Acting with tools\nfixed note';

  function commonPrefix(a: string, b: string): string {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return a.slice(0, i);
  }

  it('keeps guardrails, binding and the fixed note ahead of anything that changes per turn', () => {
    const one = service.getSystemContext(['concepts/03-cluster-as-a-concept'], {
      stable,
      page: '<surface>apps page, revision 4</surface>',
    });
    const two = service.getSystemContext(['cli/reference'], {
      stable,
      page: '<surface>backups page, revision 9</surface>',
    });
    const base = service.getBaseContext({
      stable,
      page: '<surface>apps page, revision 4</surface>',
    });

    const shared = commonPrefix(one, two);
    expect(shared).toContain(stable);
    expect(shared).toContain('# Environment you are assisting');
    expect(shared).not.toContain('<surface>');
    expect(commonPrefix(one, base)).toContain(stable);
  });

  it('puts the page after the knowledge and before the closing reminder', () => {
    const context = service.getSystemContext(
      ['concepts/03-cluster-as-a-concept'],
      { stable, page: '<surface>x</surface>' },
    );
    const knowledge = context.indexOf('# Flui knowledge');
    const page = context.indexOf('<surface>x</surface>');
    const reminder = context.lastIndexOf('# Reminder');
    expect(context.indexOf(stable)).toBeLessThan(knowledge);
    expect(knowledge).toBeLessThan(page);
    expect(page).toBeLessThan(reminder);
  });
});
