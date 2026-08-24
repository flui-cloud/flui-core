/**
 * The seam, not the parser.
 *
 * `quota-refusal.util.spec.ts` proves the sentence is read correctly. This
 * proves it is read *here* — in the one method every applied manifest passes
 * through — so that no caller has to know what a Kubernetes 403 looks like, and
 * so that a genuine failure still arrives as a genuine failure.
 *
 * The client library ships ESM and this project's jest transforms only `jose`,
 * so the module is replaced wholesale rather than transformed. Only the two
 * entry points `applyManifest` uses are stood in for; `loadAllYaml` is the real
 * parser under another name, so the manifest below is parsed for real.
 */
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

import { ForbiddenException } from '@nestjs/common';
import { KubernetesService } from './kubernetes.service';
import { QUOTA_EXCEEDED_CODE } from '../../../shared/utils/quota-refusal.util';

describe('applying a manifest against a full quota', () => {
  let service: KubernetesService;

  const QUOTA_ERROR =
    'services "shop-svc" is forbidden: exceeded quota: sandbox-quota, requested: services=1, used: services=12, limited: services=12';

  const MANIFEST = `apiVersion: v1
kind: Service
metadata:
  name: shop-svc
  namespace: user-a1b2c3
spec:
  ports:
    - port: 80
`;

  const applying = (): Promise<unknown> =>
    service.applyManifest('kubeconfig', MANIFEST).catch((e: unknown) => e);

  beforeEach(() => {
    create.mockReset();
    patch.mockReset();
    service = new KubernetesService();
    jest
      .spyOn(
        service as unknown as { loadKubeconfig: () => unknown },
        'loadKubeconfig',
      )
      .mockReturnValue({});
    // The refusal is logged as it always was; the test is about what is thrown.
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('turns the refusal into a sentence and keeps its numbers', async () => {
    create.mockRejectedValue(
      Object.assign(new Error(QUOTA_ERROR), { code: 403 }),
    );

    const error = (await applying()) as ForbiddenException;

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toContain('12 of the 12 services');
    expect(error.message).toContain('your trial allows');
  });

  it('carries the code the interface branches on', async () => {
    create.mockRejectedValue(
      Object.assign(new Error(QUOTA_ERROR), { code: 403 }),
    );

    const error = (await applying()) as ForbiddenException;

    expect((error.getResponse() as { code: string }).code).toBe(
      QUOTA_EXCEEDED_CODE,
    );
    expect(error.getStatus()).toBe(403);
  });

  it('leaves a genuine failure exactly as it was', async () => {
    const boom = Object.assign(new Error('etcdserver: request timed out'), {
      code: 500,
    });
    create.mockRejectedValue(boom);

    expect(await applying()).toBe(boom);
  });

  it('still patches what already exists instead of calling that a refusal', async () => {
    create.mockRejectedValue({ code: 409 });
    patch.mockResolvedValue({ body: {} });

    await service.applyManifest('kubeconfig', MANIFEST);

    expect(patch).toHaveBeenCalledTimes(1);
  });
});
