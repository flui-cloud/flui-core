jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ApplicationTeardownService } from './application-teardown.service';
import { ApplicationVolumeClaimsService } from '../services/application-volume-claims.service';
import { ApplicationEntity } from '../entities/application.entity';

/**
 * Deleting an application used to leave its storage behind, and both halves of
 * the existing cleanup were blind to it in the same way. Kubernetes — not Flui
 * — creates the claims a StatefulSet declares in `volumeClaimTemplates`, so
 * there is no AppResourceEntity to walk; and it labels them from the set's
 * *selector*, which on the live instance is `app=<name>` and never
 * `flui-app-id`, so the label sweep lists nothing. Proved from the wire: a
 * catalog install removed through the product left 10Gi bound in the tenant's
 * namespace with nothing running.
 *
 * It used to run only for a sandbox tenancy, on the reasoning that elsewhere
 * the survival of the volume might be a policy. Decision 49 (second half)
 * settled that it never was one — no `persistentVolumeClaimRetentionPolicy`
 * exists anywhere in this project, so the survival was the Kubernetes default
 * arriving unasked — and the gate is gone.
 */
describe('the volumes a StatefulSet leaves behind', () => {
  const app = {
    id: 'app-1',
    slug: 'demo-postgres',
    clusterId: 'cluster-1',
    k8sNamespace: 'team-blue',
  } as ApplicationEntity;

  const build = (opts: {
    claims: string[];
    /** Claims that name an owner, as the ones Flui writes itself do. */
    claimLabels?: Record<string, string>;
    /** Every StatefulSet in the namespace, ours included. */
    setsInNamespace?: string[];
    /** The set is gone by the time the sweep lists — the ordinary case. */
    liveStatefulSets?: boolean;
  }) => {
    const deleted: { kind: string; name: string; namespace: string }[] = [];
    const kubernetes = {
      listResourcesByLabel: jest.fn(
        async (
          _kubeconfig: string,
          kind: string,
          _ns: string,
          selector: string,
        ) => {
          if (kind === 'StatefulSet' && selector === `flui-app-id=${app.id}`) {
            return opts.liveStatefulSets
              ? [{ metadata: { name: 'demo-postgres' } }]
              : [];
          }
          if (kind === 'StatefulSet' && selector === '') {
            return (opts.setsInNamespace ?? []).map((name) => ({
              metadata: { name },
            }));
          }
          if (kind === 'PersistentVolumeClaim' && selector === '') {
            return opts.claims.map((name) => ({
              metadata: {
                name,
                labels: opts.claimLabels?.[name]
                  ? { 'flui-app-id': opts.claimLabels[name] }
                  : {},
              },
              spec: { resources: { requests: { storage: '10Gi' } } },
              status: { phase: 'Bound' },
            }));
          }
          return [];
        },
      ),
      deleteResource: jest.fn(
        async (
          _kubeconfig: string,
          kind: string,
          name: string,
          namespace: string,
        ) => {
          deleted.push({ kind, name, namespace });
        },
      ),
    };

    const processor = new ApplicationTeardownService(
      null as never,
      null as never,
      null as never,
      kubernetes as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      new ApplicationVolumeClaimsService(kubernetes as never),
    );
    return { processor, deleted, kubernetes };
  };

  /**
   * The delete succeeded, so by the time the sweep runs the StatefulSet is
   * neither live nor failed — it is only in the list of what was tracked when
   * the delete started. Reproducing that ordering is the whole point: a sweep
   * that reads live state instead finds nothing to delete.
   */
  const sweep = (
    processor: ApplicationTeardownService,
    tracked: { kind: string; name: string }[] = [
      { kind: 'StatefulSet', name: 'demo-postgres' },
    ],
  ) =>
    (
      processor as unknown as {
        sweepOrphanResources: (
          kubeconfig: string,
          app: ApplicationEntity,
          failed: unknown[],
          tracked: unknown[],
        ) => Promise<void>;
      }
    ).sweepOrphanResources('kubeconfig', app, [], tracked);

  const claimsDeleted = (deleted: { kind: string; name: string }[]): string[] =>
    deleted
      .filter((d) => d.kind === 'PersistentVolumeClaim')
      .map((d) => d.name);

  it('removes the claim its StatefulSet made, which carries no flui label', async () => {
    const { processor, deleted } = build({ claims: ['data-demo-postgres-0'] });
    await sweep(processor);
    expect(deleted).toContainEqual({
      kind: 'PersistentVolumeClaim',
      name: 'data-demo-postgres-0',
      namespace: 'team-blue',
    });
  });

  it('does it outside a sandbox tenancy too — the gate was never a policy', async () => {
    const { processor, deleted } = build({ claims: ['data-demo-postgres-0'] });
    await sweep(processor);
    expect(claimsDeleted(deleted)).toEqual(['data-demo-postgres-0']);
  });

  it('leaves the claims of a neighbouring application alone', async () => {
    const { processor, deleted } = build({
      claims: [
        'data-demo-postgres-0',
        'data-demo-redis-0',
        'data-other-app-postgres-0',
      ],
    });
    await sweep(processor);
    expect(claimsDeleted(deleted)).toEqual(['data-demo-postgres-0']);
  });

  /**
   * The reason the suffix match is not naive. A set called `my-demo-postgres`
   * living in the same namespace owns `data-my-demo-postgres-0`, whose name
   * ends in `-demo-postgres` all the same. Longest match wins, so the claim
   * goes to its real owner and this sweep does not touch it.
   */
  it('does not take a claim whose real owner has a longer name', async () => {
    const { processor, deleted } = build({
      claims: ['data-my-demo-postgres-0', 'data-demo-postgres-0'],
      setsInNamespace: ['my-demo-postgres'],
    });
    await sweep(processor);
    expect(claimsDeleted(deleted)).toEqual(['data-demo-postgres-0']);
  });

  it('never touches a claim that names another application as its owner', async () => {
    const { processor, deleted } = build({
      claims: ['data-demo-postgres-0'],
      claimLabels: { 'data-demo-postgres-0': 'app-2' },
    });
    await sweep(processor);
    expect(claimsDeleted(deleted)).toHaveLength(0);
  });

  it('still finds a set the label listing reports as live but nothing tracked', async () => {
    const { processor, deleted } = build({
      claims: ['data-demo-postgres-0'],
      liveStatefulSets: true,
    });
    await sweep(processor, []);
    expect(deleted).toContainEqual({
      kind: 'PersistentVolumeClaim',
      name: 'data-demo-postgres-0',
      namespace: 'team-blue',
    });
  });

  it('ignores a claim that is not a StatefulSet ordinal', async () => {
    const { processor, deleted } = build({
      claims: ['demo-postgres', 'demo-postgres-backup'],
    });
    await sweep(processor);
    expect(claimsDeleted(deleted)).toHaveLength(0);
  });

  it('does nothing at all when the application owns no StatefulSet', async () => {
    const { processor, deleted } = build({ claims: ['data-demo-postgres-0'] });
    await sweep(processor, []);
    expect(claimsDeleted(deleted)).toHaveLength(0);
  });
});
