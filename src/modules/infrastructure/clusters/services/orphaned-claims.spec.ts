jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { OrphanedClaimsService } from './orphaned-claims.service';

/**
 * Decision 49, point 3. Repairing the teardown only repairs the future: every
 * instance already running holds claims whose applications were removed before
 * it learned to take them, and nothing ever listed them.
 *
 * The whole risk of this listing is a false positive, because acting on one
 * deletes somebody's live data. So the tests that matter here are the ones that
 * prove what it REFUSES to call abandoned.
 */
describe('the volumes of applications that no longer exist', () => {
  const live = {
    id: 'app-live',
    name: 'uptime-kuma',
    slug: 'uptime-kuma',
    k8sNamespace: 'team-blue',
    clusterId: 'c1',
    deletedAt: null,
  };
  const gone = {
    id: 'app-gone',
    name: 'old-wiki',
    slug: 'old-wiki',
    k8sNamespace: 'team-blue',
    clusterId: 'c1',
    deletedAt: new Date('2026-01-02T03:04:05Z'),
  };

  const OLD = '2026-01-01T00:00:00Z';

  const build = (opts: {
    claims: {
      name: string;
      owner?: string;
      size?: string;
      labels?: Record<string, string>;
      createdAt?: string;
      namespace?: string;
    }[];
    mountedBy?: string[];
    statefulSets?: string[];
    apps?: unknown[];
    kubeconfig?: boolean;
    clusterNamespaces?: string[];
  }) => {
    const deleted: string[] = [];
    const kubernetes = {
      listNamespaces: jest.fn(
        async (): Promise<any[]> =>
          (opts.clusterNamespaces ?? []).map((name) => ({
            metadata: { name },
          })),
      ),
      listResourcesByLabel: jest.fn(
        async (
          _kc: string,
          kind: string,
          namespace: string,
        ): Promise<any[]> => {
          if (kind === 'PersistentVolumeClaim') {
            return opts.claims
              .filter((c) => !c.namespace || c.namespace === namespace)
              .map((c) => ({
                metadata: {
                  name: c.name,
                  labels: {
                    ...(c.owner ? { 'flui-app-id': c.owner } : {}),
                    ...(c.labels ?? {}),
                  },
                  creationTimestamp: c.createdAt ?? OLD,
                },
                spec: {
                  resources: { requests: { storage: c.size ?? '10Gi' } },
                },
                status: { phase: 'Bound' },
              }));
          }
          if (kind === 'Pod') {
            return [
              {
                spec: {
                  volumes: (opts.mountedBy ?? []).map((claimName) => ({
                    persistentVolumeClaim: { claimName },
                  })),
                },
              },
            ];
          }
          if (kind === 'StatefulSet') {
            return (opts.statefulSets ?? []).map((name) => ({
              metadata: { name },
            }));
          }
          return [];
        },
      ),
      deleteResource: jest.fn(
        async (_kc: string, _kind: string, name: string) => {
          deleted.push(name);
        },
      ),
    };

    const service = new OrphanedClaimsService(
      {
        findOne: jest
          .fn()
          .mockResolvedValue(
            opts.kubeconfig === false
              ? { id: 'c1' }
              : { id: 'c1', kubeconfigEncrypted: 'sealed' },
          ),
      } as never,
      {
        find: jest.fn().mockResolvedValue(opts.apps ?? [live, gone]),
      } as never,
      kubernetes as never,
      { decrypt: () => 'kubeconfig' } as never,
    );
    return { service, deleted, kubernetes };
  };

  it('reports a claim whose application was deleted', async () => {
    const { service } = build({
      claims: [{ name: 'data-old-wiki-0', owner: 'app-gone' }],
    });
    const report = await service.list('c1');
    expect(report.claims.map((c) => c.name)).toEqual(['data-old-wiki-0']);
    expect(report.claims[0].lastKnownApplication?.name).toBe('old-wiki');
    expect(report.totalLabel).toBe('10 GiB');
    expect(report.namespacesScanned).toEqual(['team-blue']);
  });

  it('never reports a claim a pod is mounting', async () => {
    const { service } = build({
      claims: [{ name: 'data-old-wiki-0', owner: 'app-gone' }],
      mountedBy: ['data-old-wiki-0'],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  it('never reports a claim that names an application still alive', async () => {
    const { service } = build({
      claims: [{ name: 'data-uptime-kuma-0', owner: 'app-live' }],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  /**
   * A StatefulSet that is running right now will re-bind its claim the moment a
   * pod is rescheduled, so "nothing mounts it" is not enough on its own.
   */
  it('never reports a claim a live StatefulSet could re-bind', async () => {
    const { service } = build({
      claims: [{ name: 'data-postgres-0' }],
      statefulSets: ['postgres'],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  /**
   * Measured on the live test instance: `flui-system/postgres-data` is Flui's
   * own database, carries no `flui-app-id`, and is not shaped like a
   * StatefulSet ordinal claim. It is also unmounted for the seconds its pod
   * takes to restart, and its namespace holds applications — so "unmounted"
   * alone would have put Flui's own storage on a list with a delete button.
   */
  it('never reports a claim that is neither labelled nor ordinal-shaped', async () => {
    const { service } = build({
      claims: [{ name: 'postgres-data' }],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  it('looks only in namespaces where Flui puts applications', async () => {
    const { service, kubernetes } = build({ claims: [] });
    await service.list('c1');
    const namespaces = new Set(
      kubernetes.listResourcesByLabel.mock.calls.map((c: unknown[]) => c[2]),
    );
    expect([...namespaces]).toEqual(['team-blue']);
  });

  /**
   * The widening decision 85 asked for, and the case the old rule could never
   * see: a composed install leaves a plain claim behind, named after the
   * application and carrying only the chart's own `app` label. Nothing about it
   * is Flui's handwriting — but the name is, because every object an install
   * creates is named after the application's slug.
   */
  it('reports a plain unlabelled claim named after an application Flui deleted', async () => {
    const { service } = build({
      claims: [{ name: 'redis-data', labels: { app: 'old-wiki-redis' } }],
    });
    const report = await service.list('c1');
    expect(report.claims.map((c) => c.name)).toEqual(['redis-data']);
    expect(report.claims[0].reason).toContain('old-wiki');
  });

  it('never reports one named after an application that is still alive', async () => {
    const { service } = build({
      claims: [{ name: 'redis-data', labels: { app: 'uptime-kuma-redis' } }],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  /**
   * The reason attribution takes the longest match. A deleted `redis` and a
   * live `redis-cache` share a prefix, and the shorter name must never decide
   * the fate of the longer one's volume.
   */
  it('never lets a deleted short name claim a live longer one', async () => {
    const { service } = build({
      claims: [{ name: 'data-redis-cache-0' }],
      apps: [
        { ...gone, slug: 'redis', name: 'redis' },
        { ...live, slug: 'redis-cache', name: 'redis-cache' },
      ],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  /**
   * A namespace exists only because Flui made it to hold applications. With
   * every one of them deleted there is nothing left that could be using a
   * volume there — and a claim nothing else attributes is exactly the leftover
   * this listing is for.
   */
  it('reports what is left in a namespace where every application is gone', async () => {
    const { service } = build({
      claims: [{ name: 'some-chart-storage' }],
      apps: [gone],
    });
    const report = await service.list('c1');
    expect(report.claims.map((c) => c.name)).toEqual(['some-chart-storage']);
    expect(report.claims[0].reason).toContain('team-blue');
  });

  /**
   * The same claim in a namespace that still holds a live application stays
   * out: nothing attributes it, and an unattributable volume next to something
   * running could be a chart's, mounted again the moment that workload is
   * scaled back up. The listing still errs by omission, deliberately.
   */
  it('leaves an unattributable claim alone while the namespace is still in use', async () => {
    const { service } = build({
      claims: [{ name: 'some-chart-storage' }],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  /**
   * Measured on the live test instance: `flui-system` holds `postgres-data`,
   * Flui's own database, unmounted for the seconds its pod takes to restart.
   * It is out of reach because the platform's namespaces are not scanned at
   * all — the same rule that refuses to *place* an application there — and no
   * longer because of the shape of its name.
   */
  it('never looks inside the platform own namespaces', async () => {
    const { service } = build({
      claims: [{ name: 'postgres-data' }],
      apps: [{ ...live, k8sNamespace: 'flui-system' }],
      clusterNamespaces: ['flui-system', 'kube-system'],
    });
    const report = await service.list('c1');
    expect(report.namespacesScanned).toEqual([]);
    expect(report.claims).toEqual([]);
  });

  /**
   * The sandbox reaper *removes* application rows rather than marking them, so
   * a tenancy whose namespace deletion failed is named by no row at all. Flui
   * labels every namespace it creates, which is how the scan still finds it.
   */
  it('finds a namespace no application row names any more', async () => {
    const { service } = build({
      claims: [{ name: 'data-something-0' }],
      apps: [],
      clusterNamespaces: ['user-guest-abcd1234'],
    });
    const report = await service.list('c1');
    expect(report.namespacesScanned).toEqual(['user-guest-abcd1234']);
    expect(report.claims.map((c) => c.name)).toEqual(['data-something-0']);
  });

  /**
   * The general form of the postgres-data lesson: every check here reads a
   * moment, not a history, so a claim that has only just appeared is far more
   * likely to be one being created than one left behind. Nothing about this
   * listing is urgent.
   */
  it('waits for a claim to settle before calling it abandoned', async () => {
    const { service } = build({
      claims: [
        {
          name: 'data-old-wiki-0',
          owner: 'app-gone',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect((await service.list('c1')).claims).toEqual([]);
  });

  it('says the scan did not run rather than reporting an empty cluster', async () => {
    const { service } = build({ claims: [], kubeconfig: false });
    const report = await service.list('c1');
    expect(report.claims).toEqual([]);
    expect(report.note).toContain('does not mean there is nothing to find');
  });

  it('removes one that is still abandoned when asked again', async () => {
    const { service, deleted } = build({
      claims: [{ name: 'data-old-wiki-0', owner: 'app-gone' }],
    });
    const result = await service.remove('c1', 'team-blue', 'data-old-wiki-0');
    expect(result.freed).toBe('10 GiB');
    expect(deleted).toEqual(['data-old-wiki-0']);
  });

  it('refuses to remove one the scan does not call abandoned', async () => {
    const { service, deleted } = build({
      claims: [{ name: 'data-uptime-kuma-0', owner: 'app-live' }],
    });
    await expect(
      service.remove('c1', 'team-blue', 'data-uptime-kuma-0'),
    ).rejects.toThrow('Nothing was deleted');
    expect(deleted).toEqual([]);
  });
});
