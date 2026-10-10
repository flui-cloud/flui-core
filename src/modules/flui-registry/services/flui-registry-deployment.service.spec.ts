jest.mock('@kubernetes/client-node', () => ({}));

import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';
import { fluiRegistryConfigFrom } from '../flui-registry.config';
import { FluiRegistryDeploymentService } from './flui-registry-deployment.service';

const harness = (
  mode: string,
  extra: Record<string, string> = {},
  bucket = false,
  current: unknown = null,
) => {
  const applied: string[] = [];
  const deleted: string[] = [];
  const service = new FluiRegistryDeploymentService(
    fluiRegistryConfigFrom(
      (key) =>
        ({
          FLUI_IMAGE_REGISTRY: mode,
          PUBLIC_API_URL: 'https://api.example.test',
          ...extra,
        })[key],
    ),
    { publicKeyPem: async () => 'PEM' } as never,
    {
      connected: async () =>
        bucket
          ? {
              s3: {
                endpoint: 'https://s3.fr-par.scw.cloud',
                region: 'fr-par',
                bucket: 'flui-registry-abc',
                prefix: 'zot',
                forcePathStyle: false,
                accessKey: 'k',
                secretKey: 's',
              },
              cachePassword: 'p',
            }
          : null,
    } as never,
    {
      readObject: async (_kc: string, _v: string, kind: string) =>
        kind === 'IngressRoute'
          ? { spec: { tls: { secretName: 'flui-system-tls' } } }
          : current,
      deleteObject: async (_kc: string, _v: string, kind: string) => {
        deleted.push(kind);
      },
      applyManifest: async (_kc: string, manifest: string) => {
        applied.push(manifest);
      },
    } as never,
    { decrypt: () => 'kubeconfig' } as never,
    {
      find: async () => [
        {
          name: 'workload-1',
          clusterType: 'workload',
          kubeconfigEncrypted: 'x',
          status: ClusterStatus.READY,
        },
        {
          name: 'control',
          clusterType: 'control',
          kubeconfigEncrypted: 'x',
          status: ClusterStatus.READY,
        },
      ],
    } as never,
  );
  return { service, applied, deleted };
};

describe('putting the registry in place', () => {
  it('creates nothing on an instance that keeps its images on GHCR', async () => {
    const { service, applied } = harness('ghcr');
    service.onApplicationBootstrap();
    await expect(service.reconcile()).resolves.toBe(false);
    expect(applied).toEqual([]);
  });

  it('applies it to the control cluster, with the API route’s certificate', async () => {
    const { service, applied } = harness('flui');
    await expect(service.reconcile()).resolves.toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('secretName: flui-system-tls');
    expect(applied[0]).toContain('kind: IngressRoute');
  });

  it('waits for a bucket before running on object storage', async () => {
    const { service, applied } = harness('flui', {
      FLUI_REGISTRY_STORAGE_BACKEND: 's3',
    });
    await expect(service.reconcile()).rejects.toThrow(/needs a bucket/);
    expect(applied).toEqual([]);
  });

  it('runs on the connected bucket, with its cache and a maintenance copy', async () => {
    const { service, applied } = harness(
      'flui',
      { FLUI_REGISTRY_STORAGE_BACKEND: 's3', FLUI_REGISTRY_REPLICAS: '2' },
      true,
    );
    await service.reconcile();
    expect(applied[0]).toContain('name: flui-registry-cache');
    expect(applied[0]).toContain('name: flui-registry-maintenance');
    expect(applied[0]).not.toContain('PersistentVolumeClaim');
  });

  it('replaces a registry Deployment whose selector predates roles, and leaves a current one', async () => {
    const outdated = harness('flui', {}, false, {
      spec: { selector: { matchLabels: { app: 'flui-registry' } } },
    });
    await outdated.service.reconcile();
    expect(outdated.deleted).toEqual(['Deployment']);

    const current = harness('flui', {}, false, {
      spec: {
        selector: {
          matchLabels: {
            app: 'flui-registry',
            'flui.cloud/registry-role': 'serve',
          },
        },
      },
    });
    await current.service.reconcile();
    expect(current.deleted).toEqual([]);
  });
});

describe('knowing when every copy has moved', () => {
  const deployment = (status: Record<string, number>, replicas = 2) => ({
    metadata: { generation: 3 },
    spec: { replicas, selector: { matchLabels: {} } },
    status: { observedGeneration: 3, ...status },
  });
  const s3 = { FLUI_REGISTRY_STORAGE_BACKEND: 's3' };

  it('is settled once each copy runs the current configuration', async () => {
    const { service } = harness(
      'flui',
      s3,
      true,
      deployment({ replicas: 2, updatedReplicas: 2, readyReplicas: 2 }),
    );
    await expect(service.settled()).resolves.toBe(true);
  });

  it('is not while an old copy still runs beside a new one that is not ready', async () => {
    const { service } = harness(
      'flui',
      s3,
      true,
      deployment({ replicas: 3, updatedReplicas: 1, readyReplicas: 2 }),
    );
    await expect(service.settled()).resolves.toBe(false);
  });

  it('is not before the change has even been seen', async () => {
    const { service } = harness('flui', s3, true, {
      ...deployment({ replicas: 2, updatedReplicas: 2, readyReplicas: 2 }),
      status: {
        observedGeneration: 2,
        replicas: 2,
        updatedReplicas: 2,
        readyReplicas: 2,
      },
    });
    await expect(service.settled()).resolves.toBe(false);
  });
});
