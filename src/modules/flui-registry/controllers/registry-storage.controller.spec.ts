jest.mock('@kubernetes/client-node', () => ({}));

import { fluiRegistryConfigFrom } from '../flui-registry.config';
import { RegistryStorageController } from './registry-storage.controller';

const harness = (env: Record<string, string>, settled = true) => {
  const order: string[] = [];
  const controller = new RegistryStorageController(
    fluiRegistryConfigFrom((key) => env[key]),
    {
      status: async () => ({ connected: true, bucket: 'flui-registry-abc' }),
      remove: async (id: string) => {
        order.push(`remove:${id}`);
        return { bucket: 'flui-registry-abc', bucketDeleted: true };
      },
      connect: async () => {
        order.push('connect');
      },
    } as never,
    {
      provision: async (region: string) => {
        order.push(`provision:${region}`);
        return { bucket: 'flui-registry-abc' };
      },
    } as never,
    {
      reconcile: async () => {
        order.push('reconcile');
        return true;
      },
      settled: async () => settled,
    } as never,
    {
      current: async () => ({ totalBytes: 10 }),
      measure: async () => ({ totalBytes: 20 }),
    } as never,
  );
  return { controller, order };
};

describe('connecting the registry to a bucket', () => {
  it('creates the Scaleway bucket, records it, then puts the registry on it', async () => {
    const { controller, order } = harness({
      FLUI_IMAGE_REGISTRY: 'flui',
      FLUI_REGISTRY_STORAGE_BACKEND: 's3',
    });
    const status = await controller.connectScaleway({ region: 'fr-par' });
    expect(order).toEqual(['provision:fr-par', 'connect', 'reconcile']);
    expect(status).toMatchObject({ connected: true, backend: 's3' });
  });

  it('records a bucket without touching the registry while it still runs on a volume', async () => {
    const { controller, order } = harness({ FLUI_IMAGE_REGISTRY: 'flui' });
    await controller.connectScaleway({ region: 'fr-par' });
    expect(order).toEqual(['provision:fr-par', 'connect']);
    expect((await controller.status()).backend).toBe('filesystem');
  });

  it('reports the space in use only when the instance runs its own registry, measured again on request', async () => {
    const ghcr = harness({});
    expect((await ghcr.controller.status()).usage).toBeUndefined();

    const { controller } = harness({ FLUI_IMAGE_REGISTRY: 'flui' });
    expect((await controller.status()).usage?.totalBytes).toBe(10);
    expect((await controller.status('true')).usage?.totalBytes).toBe(20);
  });

  it('removes no bucket while some copies of the registry may still read it', async () => {
    const s3 = {
      FLUI_IMAGE_REGISTRY: 'flui',
      FLUI_REGISTRY_STORAGE_BACKEND: 's3',
    };
    const moving = harness(s3, false);
    await expect(
      moving.controller.removeBucket('00000000-0000-4000-8000-000000000001'),
    ).rejects.toThrow(/still moving/);
    expect(moving.order).toEqual([]);

    const done = harness(s3, true);
    await done.controller.removeBucket('00000000-0000-4000-8000-000000000001');
    expect(done.order).toEqual(['remove:00000000-0000-4000-8000-000000000001']);
  });
});
