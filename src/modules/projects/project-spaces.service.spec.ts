jest.mock('@kubernetes/client-node', () => ({}));

import { ProjectSpacesService } from './project-spaces.service';

describe('ProjectSpacesService', () => {
  const build = (
    spaces: Record<string, Record<string, string> | null | 'down'>,
  ) => {
    const deleted: string[] = [];
    const service = new ProjectSpacesService(
      {
        find: jest.fn(async () =>
          Object.keys(spaces).map((name) => ({
            id: name,
            name,
            kubeconfigEncrypted: name,
          })),
        ),
      } as never,
      {
        getResource: jest.fn(async (kc: string) => {
          const labels = spaces[kc];
          if (labels === 'down') throw new Error('connect ETIMEDOUT');
          return labels ? { metadata: { labels } } : null;
        }),
        deleteNamespace: jest.fn(async (kc: string, ns: string) => {
          deleted.push(`${kc}/${ns}`);
        }),
      } as never,
      { decrypt: (v: string) => v } as never,
    );
    return { service, deleted };
  };

  it("removes the project's space wherever it says it is that project's", async () => {
    const { service, deleted } = build({
      production: { 'flui.cloud/project': 'p1' },
      staging: { 'flui.cloud/project': 'someone-else' },
      empty: null,
    });

    const result = await service.removeAll({ id: 'p1', slug: 'team' });

    expect(deleted).toEqual(['production/p-team']);
    expect(result).toEqual({ removed: ['production'], failed: [] });
  });

  it('names the cluster that did not answer', async () => {
    const { service } = build({ production: 'down' });

    const result = await service.removeAll({ id: 'p1', slug: 'team' });

    expect(result.failed).toEqual([
      { cluster: 'production', error: 'connect ETIMEDOUT' },
    ]);
  });
});
