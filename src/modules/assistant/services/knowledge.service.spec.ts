import { KnowledgeService } from './knowledge.service';

describe('KnowledgeService.docLinksFor', () => {
  const service = new KnowledgeService();

  it('maps a concept id to its docs.flui.cloud route (numeric prefix kept)', () => {
    expect(service.docLinksFor(['concepts/03-cluster-as-a-concept'])).toEqual([
      {
        title: 'Cluster as a concept',
        url: 'https://docs.flui.cloud/concepts/03-cluster-as-a-concept/',
      },
    ]);
  });

  it('maps a cli id and collapses /index to the directory root', () => {
    expect(
      service.docLinksFor(['cli/clusters-and-nodes', 'cli/index']),
    ).toEqual([
      {
        title: 'Clusters, nodes, and SSH',
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
