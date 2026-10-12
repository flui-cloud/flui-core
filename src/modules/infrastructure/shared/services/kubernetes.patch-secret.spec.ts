const create = jest.fn();
const patch = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  loadAllYaml: (yaml: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('js-yaml') as { loadAll: (s: string) => unknown[] }).loadAll(yaml),
  KubernetesObjectApi: { makeApiClient: () => ({ create, patch }) },
  KubeConfig: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { KubernetesService } from './kubernetes.service';

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

describe('patching an application Secret', () => {
  let service: KubernetesService;

  beforeEach(() => {
    create.mockReset().mockResolvedValue({ body: {} });
    patch.mockReset().mockResolvedValue({ body: {} });
    service = new KubernetesService();
    jest
      .spyOn(
        service as unknown as { loadKubeconfig: () => unknown },
        'loadKubeconfig',
      )
      .mockReturnValue({});
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('merges the keys and leaves the deploy-time last-applied annotation alone', async () => {
    await service.patchSecret('kc', 'ns', 'db-secret', { URL: 'pg://x' });

    expect(create).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
    const [object] = patch.mock.calls[0];
    expect(object).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'db-secret', namespace: 'ns' },
      stringData: { URL: 'pg://x' },
    });
  });

  it('creates the Secret when it does not exist yet', async () => {
    patch.mockRejectedValueOnce(Object.assign(new Error('nf'), { code: 404 }));

    await service.patchSecret('kc', 'ns', 'db-secret', { URL: 'pg://x' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(
      create.mock.calls[0][0].metadata.annotations[LAST_APPLIED],
    ).toBeDefined();
  });

  it('surfaces any other failure', async () => {
    patch.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 500 }),
    );

    await expect(
      service.patchSecret('kc', 'ns', 'db-secret', { URL: 'pg://x' }),
    ).rejects.toThrow('boom');
    expect(create).not.toHaveBeenCalled();
  });
});
