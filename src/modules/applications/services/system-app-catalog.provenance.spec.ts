jest.mock('@kubernetes/client-node', () => ({}));

import { SystemAppCatalogService } from './system-app-catalog.service';
import { ApplicationCategory } from '../enums/application-category.enum';

/**
 * Discovery stood in front of `flui.cloud/owner-kind` on every resource it
 * found and wrote `userId = null` instead — a declaration turned into an
 * absence. These tests hold the two halves of the fix: the row records what the
 * cluster declares, and a row written before the columns existed converges on
 * the next pass rather than being guessed at by a data migration.
 */
describe('discovery carries the declared provenance into the row', () => {
  const PLATFORM_LABELS = {
    'flui.cloud/managed': 'true',
    'flui.cloud/scope': 'system',
    'flui.cloud/app-kind': 'SYSTEM',
    'flui.cloud/owner-kind': 'platform',
    'flui.cloud/owner-id': 'flui-core',
  };

  function harness(options: {
    existing?: Array<Record<string, unknown>>;
    labels?: Record<string, string> | null;
  }) {
    const created: Array<Record<string, unknown>> = [];
    const updated: Array<[string, Record<string, unknown>]> = [];

    // Only postgres answers on the cluster; everything else is absent, so the
    // run stays a single app wide without stubbing the whole catalog.
    const getResource = jest.fn(
      async (_kc: string, kind: string, name: string) => {
        if (name !== 'postgres') return null;
        if (kind !== 'StatefulSet' && kind !== 'Service') return null;
        return {
          kind,
          metadata: {
            name,
            namespace: 'flui-system',
            resourceVersion: '1',
            ...(options.labels === null
              ? {}
              : { labels: options.labels ?? PLATFORM_LABELS }),
          },
          spec: { ports: [{ port: 5432 }] },
        };
      },
    );

    const service = new SystemAppCatalogService(
      {
        findOne: async () => ({
          id: 'c1',
          clusterType: 'control',
          kubeconfigEncrypted: 'enc',
        }),
      } as never,
      {
        getResource,
        applyManifest: jest.fn(async () => []),
        getDeploymentContainerImage: jest.fn(async () => null),
      } as never,
      { decrypt: () => 'kubeconfig' } as never,
      {
        findByClusterIdAndCategory: async (
          _id: string,
          cat: ApplicationCategory,
        ) =>
          cat === ApplicationCategory.SYSTEM ? (options.existing ?? []) : [],
        create: async (data: Record<string, unknown>) => {
          created.push(data);
          return { id: 'app-1', ...data };
        },
        update: async (id: string, data: Record<string, unknown>) => {
          updated.push([id, data]);
          return { id, ...data };
        },
      } as never,
      { create: async () => ({ id: 'res-1' }) } as never,
    );
    return { service, created, updated };
  }

  it('writes ownerKind and ownerRef from the labels the bootstrap declares', async () => {
    const { service, created } = harness({});
    await service.discoverSystemApps('c1');

    const postgres = created.find((c) => c.slug === 'postgres');
    expect(postgres).toBeDefined();
    expect(postgres!.ownerKind).toBe('platform');
    expect(postgres!.ownerRef).toBe('flui-core');
  });

  it('records no provenance when the resource declares none', async () => {
    const { service, created } = harness({ labels: null });
    await service.discoverSystemApps('c1');

    const postgres = created.find((c) => c.slug === 'postgres');
    expect(postgres!.ownerKind).toBeNull();
    expect(postgres!.ownerRef).toBeNull();
  });

  /**
   * The convergence that stands in for a data backfill. Every row already on
   * the instance carries nothing; nothing in SQL could tell which of them the
   * platform put there without guessing at slugs — and guessing would stamp
   * `platform` on exactly the rows whose missing owner is a defect.
   */
  it('converges a row written before the columns existed', async () => {
    const { service, updated } = harness({
      existing: [
        {
          id: 'old-1',
          slug: 'postgres',
          labels: { app: 'postgres' },
          exposure: 'cluster',
          ownerKind: null,
          ownerRef: null,
        },
      ],
    });
    await service.discoverSystemApps('c1');

    expect(updated).toContainEqual([
      'old-1',
      { ownerKind: 'platform', ownerRef: 'flui-core' },
    ]);
  });

  it('leaves a converged row alone on the next pass', async () => {
    const { service, updated } = harness({
      existing: [
        {
          id: 'old-1',
          slug: 'postgres',
          labels: { app: 'postgres' },
          exposure: 'cluster',
          ownerKind: 'platform',
          ownerRef: 'flui-core',
        },
      ],
    });
    await service.discoverSystemApps('c1');

    expect(updated.some(([, data]) => 'ownerKind' in data)).toBe(false);
  });

  /**
   * Silence is not a denial. A resource that could not be read leaves the row
   * as it stands — otherwise one missed API call would make discovery the
   * source of the very absence it exists to remove.
   */
  it('does not erase a provenance when the cluster answers nothing', async () => {
    const { service, updated } = harness({
      existing: [
        {
          id: 'old-1',
          slug: 'redis',
          labels: { app: 'redis' },
          exposure: 'cluster',
          ownerKind: 'platform',
          ownerRef: 'flui-core',
        },
      ],
    });
    await service.discoverSystemApps('c1');

    expect(updated.some(([id]) => id === 'old-1')).toBe(false);
  });
});
