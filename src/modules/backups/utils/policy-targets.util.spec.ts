import { policyTargets } from './policy-targets.util';

describe('policyTargets', () => {
  it('counts an application on a deleted cluster as gone with it, and links none', () => {
    const t = policyTargets(
      {
        clusterId: 'c1',
        scopeSelector: { applicationIds: ['a1', 'a2', 'a3'] },
      },
      { id: 'c1', name: 'wc-1', status: 'deleted' },
      [
        { id: 'a1', name: 'Orders DB', slug: 'pg-orders', status: 'failed' },
        {
          id: 'a2',
          name: 'old',
          slug: 'old',
          status: 'running',
          deletedAt: new Date(),
        },
      ],
    );
    expect(t.cluster).toEqual({ id: 'c1', name: 'wc-1', gone: true });
    expect(t.applications).toEqual([
      {
        id: 'a1',
        name: 'Orders DB',
        slug: 'pg-orders',
        path: null,
        gone: true,
        goneWith: 'cluster',
      },
      { id: 'a2', name: 'old', slug: 'old', path: null, gone: true },
      { id: 'a3', name: null, slug: null, path: null, gone: true },
    ]);
  });

  it('links an application that still runs on a live cluster', () => {
    const t = policyTargets(
      { clusterId: 'c1', scopeSelector: { applicationIds: ['a1'] } },
      { id: 'c1', name: 'wc-1', status: 'ready' },
      [{ id: 'a1', name: 'web', slug: 'web', status: 'running' }],
    );
    expect(t.applications[0]).toEqual({
      id: 'a1',
      name: 'web',
      slug: 'web',
      path: '/apps/applications/a1',
      gone: false,
    });
  });

  it('has no applications for a policy that covers a whole cluster', () => {
    expect(policyTargets({ clusterId: 'c1' }, null, []).applications).toEqual(
      [],
    );
  });
});
