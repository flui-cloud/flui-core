jest.mock('@kubernetes/client-node', () => ({}));

import { SystemAppCatalogService } from './system-app-catalog.service';

const API_DEF = {
  name: 'Flui API',
  k8sNamespace: 'flui-system',
  k8sAppLabel: 'flui-api',
  expectedResources: [],
  imageSource: { containerName: 'flui-api' },
};

function harness(inFlight: Record<string, unknown> | null) {
  const update = jest.fn().mockResolvedValue(undefined);
  const service = new SystemAppCatalogService(
    {} as never,
    {
      getDeploymentContainerImage: jest
        .fn()
        .mockResolvedValue('ghcr.io/flui-cloud/core:0.14.0-rc.3'),
    } as never,
    {} as never,
    { update } as never,
    {} as never,
    { findOne: jest.fn().mockResolvedValue(inFlight) } as never,
  );
  const refresh = (
    service as unknown as {
      refreshSystemAppImageRef: (
        kc: string,
        id: string,
        def: unknown,
      ) => Promise<void>;
    }
  ).refreshSystemAppImageRef.bind(service);
  return { refresh, update };
}

describe('a copy of the API booting reads what the platform runs', () => {
  it('leaves the wanted image alone while a deploy is carrying it', async () => {
    const now = new Date();
    const t = harness({ createdAt: now, updatedAt: now });

    await t.refresh('kc', 'app-api', API_DEF);

    expect(t.update).toHaveBeenCalledWith('app-api', {
      observedImageRef: 'ghcr.io/flui-cloud/core:0.14.0-rc.3',
    });
  });

  it('takes the live image as the wanted one when nothing is deploying', async () => {
    const t = harness(null);

    await t.refresh('kc', 'app-api', API_DEF);

    expect(t.update).toHaveBeenCalledWith('app-api', {
      observedImageRef: 'ghcr.io/flui-cloud/core:0.14.0-rc.3',
      imageRef: 'ghcr.io/flui-cloud/core:0.14.0-rc.3',
    });
  });

  it('does not let a deploy nobody carries any more freeze the record', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const t = harness({ createdAt: old, updatedAt: old });

    await t.refresh('kc', 'app-api', API_DEF);

    expect(t.update.mock.calls[0][1]).toHaveProperty('imageRef');
  });
});
