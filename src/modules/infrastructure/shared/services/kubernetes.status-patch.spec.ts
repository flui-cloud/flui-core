const patchNamespacedCustomObjectStatus = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  CustomObjectsApi: class {},
}));

import { KubernetesService } from './kubernetes.service';

describe('KubernetesService.jsonPatchObjectStatus', () => {
  it('sends the JSON patch to the status subresource of the named object', async () => {
    const service = new KubernetesService();
    const makeApiClient = jest.fn(() => ({
      patchNamespacedCustomObjectStatus,
    }));
    jest
      .spyOn(
        service as unknown as { loadKubeconfig: () => unknown },
        'loadKubeconfig',
      )
      .mockReturnValue({ makeApiClient });
    patchNamespacedCustomObjectStatus.mockResolvedValue({});
    const operations = [
      { op: 'remove', path: '/status/lastFailureTime' },
      { op: 'remove', path: '/status/failedIssuanceAttempts' },
    ];

    await service.jsonPatchObjectStatus(
      'kc',
      {
        apiVersion: 'cert-manager.io/v1',
        plural: 'certificates',
        name: 'tls-shop-example-com',
        namespace: 'ns',
      },
      operations,
    );

    expect(patchNamespacedCustomObjectStatus).toHaveBeenCalledWith({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: 'ns',
      plural: 'certificates',
      name: 'tls-shop-example-com',
      body: operations,
      fieldManager: 'flui-api',
    });
  });
});
