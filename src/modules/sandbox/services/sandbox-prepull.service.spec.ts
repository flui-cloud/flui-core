// The service reaches the Kubernetes client through its import graph only; the
// suite drives stubs and constructs none of it.
jest.mock('@kubernetes/client-node', () => ({}));

import { SandboxPrepullService } from './sandbox-prepull.service';
import { CatalogAppType } from '../../catalog/enums/catalog-app-type.enum';
import { loadSandboxConfig } from '../sandbox.config';

/**
 * This manifest was written, tested and never called for a week, which is worse
 * than not having it: an uncalled defence still counts itself among the
 * defences. These tests are about the call, not the YAML.
 */

const config = loadSandboxConfig({
  SANDBOX_ENABLED: 'true',
  SANDBOX_CLUSTER_ID: 'c1',
} as NodeJS.ProcessEnv);

const definition = (slug: string, spec: Record<string, unknown>) => ({
  slug,
  isActive: true,
  manifest: { spec },
});

const build = (over: {
  definitions?: unknown[];
  cluster?: unknown;
  config?: ReturnType<typeof loadSandboxConfig>;
}) => {
  const applied: string[] = [];
  const k8s = {
    applyManifest: async (_kc: string, manifest: string) => {
      applied.push(manifest);
    },
  };
  const service = new SandboxPrepullService(
    k8s as never,
    { decrypt: () => 'kubeconfig' } as never,
    {
      findOne: async () =>
        over.cluster === undefined
          ? { id: 'c1', kubeconfigEncrypted: 'enc' }
          : over.cluster,
    } as never,
    { find: async () => over.definitions ?? [] } as never,
    over.config ?? config,
  );
  return { service, applied };
};

describe('SandboxPrepullService', () => {
  it('warms every image of a composed entry, not only its web half', async () => {
    const { service, applied } = build({
      definitions: [
        definition('umami', {
          type: CatalogAppType.COMPOSED,
          components: [
            {
              image: { repository: 'ghcr.io/umami-software/umami', tag: 'v2' },
            },
            { image: { repository: 'postgres', tag: '17' } },
          ],
        }),
      ],
    });

    const images = await service.warmImages();

    expect(images).toEqual(['ghcr.io/umami-software/umami:v2', 'postgres:17']);
    expect(applied[0]).toContain('kind: DaemonSet');
    expect(applied[0]).toContain('postgres:17');
  });

  // One broken entry costing the warm cache of every other one would make the
  // whole thing fail closed in the direction nobody wants.
  it('skips an entry whose image cannot be resolved and keeps the rest', async () => {
    const { service } = build({
      definitions: [
        definition('gitea', {
          type: CatalogAppType.STANDALONE,
          image: { repository: 'gitea/gitea', tag: '1.26' },
        }),
        definition('broken', {
          type: CatalogAppType.STANDALONE,
          image: { tag: 'latest' },
        }),
      ],
    });

    await expect(service.warmImages()).resolves.toEqual(['gitea/gitea:1.26']);
  });

  it('does nothing at all when no cluster hosts the sandbox', async () => {
    const { service, applied } = build({
      config: loadSandboxConfig({
        SANDBOX_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    });

    await expect(service.warmImages()).resolves.toEqual([]);
    expect(applied).toHaveLength(0);
  });

  // A cold cache costs seconds. Applying a DaemonSet against a cluster we
  // cannot read costs a stack trace every hour and warms nothing.
  it('says so and stops when the cluster has no kubeconfig', async () => {
    const { service, applied } = build({
      cluster: null,
      definitions: [
        definition('gitea', {
          type: CatalogAppType.STANDALONE,
          image: { repository: 'gitea/gitea', tag: '1.26' },
        }),
      ],
    });

    await expect(service.warmImages()).resolves.toEqual([]);
    expect(applied).toHaveLength(0);
  });
});
