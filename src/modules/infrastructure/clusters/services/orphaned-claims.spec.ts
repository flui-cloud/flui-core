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
    k8sNamespace: 'team-blue',
    clusterId: 'c1',
    deletedAt: null,
  };
  const gone = {
    id: 'app-gone',
    name: 'old-wiki',
    k8sNamespace: 'team-blue',
    clusterId: 'c1',
    deletedAt: new Date('2026-01-02T03:04:05Z'),
  };

  const build = (opts: {
    claims: { name: string; owner?: string; size?: string }[];
    mountedBy?: string[];
    statefulSets?: string[];
    apps?: unknown[];
    kubeconfig?: boolean;
  }) => {
    const deleted: string[] = [];
    const kubernetes = {
      listResourcesByLabel: jest.fn(
        async (_kc: string, kind: string): Promise<any[]> => {
          if (kind === 'PersistentVolumeClaim') {
            return opts.claims.map((c) => ({
              metadata: {
                name: c.name,
                labels: c.owner ? { 'flui-app-id': c.owner } : {},
                creationTimestamp: '2026-01-01T00:00:00Z',
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
