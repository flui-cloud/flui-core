// The service's import graph reaches ESM-only packages ts-jest cannot
// transform; this suite constructs it with stubs and calls one method.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { RemovalPreviewService } from './removal-preview.service';
import { ApplicationVolumeClaimsService } from '../../applications/services/application-volume-claims.service';

/**
 * Decision 49, point 2: the most destructive verb in the product never said how
 * much it destroyed. It says it here, once, in the API — so the dashboard, the
 * CLI and the MCP tool cannot drift apart on the number.
 *
 * The one thing this must never do is reassure. An empty list is only "no data"
 * when the cluster was actually read; otherwise it is "not known", and every
 * surface is told which of the two it is holding.
 */
describe('what a removal says it will take away', () => {
  const app = {
    id: 'app-1',
    name: 'uptime-kuma',
    slug: 'uptime-kuma',
    clusterId: 'cluster-1',
    k8sNamespace: 'team-blue',
  };
  const sibling = {
    id: 'app-2',
    name: 'immich-postgres',
    slug: 'immich-postgres',
    clusterId: 'cluster-1',
    k8sNamespace: 'team-blue',
  };

  const build = (opts: {
    install?: { displayName: string; applicationIds: string[] } | null;
    claims?: Record<string, string>;
    trackedSets?: string[];
    kubeconfig?: boolean;
  }) => {
    const kubernetes = {
      listResourcesByLabel: jest.fn(
        async (
          _kc: string,
          kind: string,
          _ns: string,
          selector: string,
        ): Promise<any[]> => {
          if (kind === 'StatefulSet') {
            return (opts.trackedSets ?? []).map((name) => ({
              metadata: { name },
            }));
          }
          if (kind === 'PersistentVolumeClaim' && selector === '') {
            return Object.entries(opts.claims ?? {}).map(([name, size]) => ({
              metadata: { name },
              spec: { resources: { requests: { storage: size } } },
              status: { phase: 'Bound' },
            }));
          }
          return [];
        },
      ),
    };

    const byId: Record<string, unknown> = { 'app-1': app, 'app-2': sibling };
    const service = new RemovalPreviewService(
      {
        findOne: jest
          .fn()
          .mockResolvedValue(
            opts.kubeconfig === false
              ? { id: 'cluster-1' }
              : { id: 'cluster-1', kubeconfigEncrypted: 'sealed' },
          ),
      } as never,
      { decrypt: () => 'kubeconfig' } as never,
      { findById: jest.fn().mockResolvedValue(app) } as never,
      {
        findById: jest.fn(async (id: string) => byId[id] ?? null),
      } as never,
      { findByApplicationId: jest.fn().mockResolvedValue([]) } as never,
      new ApplicationVolumeClaimsService(kubernetes as never),
      {
        findInstallByApplicationId: jest
          .fn()
          .mockResolvedValue(opts.install ?? null),
      } as never,
    );
    return { service, kubernetes };
  };

  it('names the size and the count in one sentence', async () => {
    const { service } = build({
      trackedSets: ['uptime-kuma'],
      claims: { 'data-uptime-kuma-0': '10Gi' },
    });
    const preview = await service.preview('app-1');
    expect(preview.dataWarning).toBe(
      'This also deletes 10 GiB of data in 1 volume. It cannot be undone.',
    );
    expect(preview.totalLabel).toBe('10 GiB');
    expect(preview.volumes).toHaveLength(1);
    expect(preview.removes).toBe('application');
  });

  it('previews the whole install when the id is one component of one', async () => {
    const { service } = build({
      install: { displayName: 'Immich', applicationIds: ['app-1', 'app-2'] },
      trackedSets: ['uptime-kuma'],
      claims: { 'data-uptime-kuma-0': '10Gi' },
    });
    const preview = await service.preview('app-1');
    expect(preview.removes).toBe('catalog-install');
    expect(preview.label).toBe('Uninstall Immich');
    expect(preview.applications.map((a) => a.name)).toEqual([
      'uptime-kuma',
      'immich-postgres',
    ]);
  });

  /**
   * Two components of one install share a namespace, so the same claim is
   * reachable through both. Counting it twice would double the number a person
   * reads before pressing a button they cannot undo.
   */
  it('counts a shared claim once', async () => {
    const { service } = build({
      install: { displayName: 'Immich', applicationIds: ['app-1', 'app-2'] },
      trackedSets: ['uptime-kuma'],
      claims: { 'data-uptime-kuma-0': '10Gi' },
    });
    const preview = await service.preview('app-1');
    expect(preview.volumes).toHaveLength(1);
    expect(preview.totalLabel).toBe('10 GiB');
  });

  it('says nothing is at stake only when it actually read the cluster', async () => {
    const { service } = build({ trackedSets: ['uptime-kuma'], claims: {} });
    const preview = await service.preview('app-1');
    expect(preview.volumesKnown).toBe(true);
    expect(preview.dataWarning).toBeNull();
  });

  it('refuses to imply "no data" when the cluster could not be read', async () => {
    const { service } = build({ kubeconfig: false });
    const preview = await service.preview('app-1');
    expect(preview.volumesKnown).toBe(false);
    expect(preview.volumes).toEqual([]);
    expect(preview.dataWarning).toBeNull();
    expect(preview.note).toContain('not known to be none');
  });

  it('adds the sizes up across several volumes', async () => {
    const { service } = build({
      trackedSets: ['uptime-kuma'],
      claims: {
        'data-uptime-kuma-0': '10Gi',
        'wal-uptime-kuma-0': '2Gi',
      },
    });
    const preview = await service.preview('app-1');
    expect(preview.volumes).toHaveLength(2);
    expect(preview.dataWarning).toBe(
      'This also deletes 12 GiB of data in 2 volumes. It cannot be undone.',
    );
  });
});
