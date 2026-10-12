const create = jest.fn();
const patch = jest.fn();
const read = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  loadAllYaml: (yaml: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('js-yaml') as { loadAll: (s: string) => unknown[] }).loadAll(yaml),
  KubernetesObjectApi: { makeApiClient: () => ({ create, patch, read }) },
  KubeConfig: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { KubernetesService } from './kubernetes.service';

describe('applying a Service that pins its cluster address', () => {
  let service: KubernetesService;

  const manifest = (clusterIP?: string) => `apiVersion: v1
kind: Service
metadata:
  name: db-pooler-upstream
  namespace: ns
spec:
${clusterIP ? `  clusterIP: ${clusterIP}\n` : ''}  ports:
    - port: 5432
`;

  const allocated = Object.assign(
    new Error('provided IP is already allocated'),
    { code: 422 },
  );

  beforeEach(() => {
    create.mockReset();
    patch.mockReset().mockResolvedValue({ body: {} });
    read.mockReset();
    service = new KubernetesService();
    jest
      .spyOn(
        service as unknown as { loadKubeconfig: () => unknown },
        'loadKubeconfig',
      )
      .mockReturnValue({});
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('patches it when it already exists, though the create came back 422', async () => {
    create.mockRejectedValue(allocated);
    read.mockResolvedValue({ body: {} });

    await service.applyManifest('kc', manifest('10.43.150.74'));

    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('keeps the 422 when the Service does not exist: the address is held by another', async () => {
    create.mockRejectedValue(allocated);
    read.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 404 }),
    );

    await expect(
      service.applyManifest('kc', manifest('10.43.150.74')),
    ).rejects.toThrow(/already allocated/);
    expect(patch).not.toHaveBeenCalled();
  });

  it('never reads back a 422 for a Service without a pinned address', async () => {
    create.mockRejectedValue(
      Object.assign(new Error('invalid port'), { code: 422 }),
    );

    await expect(service.applyManifest('kc', manifest())).rejects.toThrow(
      /invalid port/,
    );
    expect(read).not.toHaveBeenCalled();
  });
});
