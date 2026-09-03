jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: class {},
  StorageV1Api: class {},
}));

import { SnapshotStorageCapabilityService } from './snapshot-storage-capability.service';

describe('SnapshotStorageCapabilityService', () => {
  function createService(options: {
    pvcNotFound?: boolean;
    storageClassName?: string | null;
    storageClassNotFound?: boolean;
  }): SnapshotStorageCapabilityService {
    const coreApi = {
      readNamespacedPersistentVolumeClaim: options.pvcNotFound
        ? jest.fn().mockRejectedValue({ response: { statusCode: 404 } })
        : jest.fn().mockResolvedValue({
            spec: {
              storageClassName: options.storageClassName ?? 'flui-local',
            },
          }),
    };
    const storageApi = {
      readStorageClass: options.storageClassNotFound
        ? jest.fn().mockRejectedValue({ response: { statusCode: 404 } })
        : jest.fn().mockResolvedValue({}),
    };
    const makeApiClient = jest
      .fn()
      .mockReturnValueOnce(coreApi)
      .mockReturnValueOnce(storageApi);
    return new SnapshotStorageCapabilityService({
      makeKubeConfig: jest.fn().mockReturnValue({ makeApiClient }),
    } as any);
  }

  it('supports a bound PVC on a local-path StorageClass — the copy-pod primitive never touches CSI', async () => {
    const service = createService({ storageClassName: 'flui-local' });
    await expect(
      service.forPvc('kubeconfig', 'app-example', 'data'),
    ).resolves.toEqual({ supported: true });
  });

  it('is unsupported when the PVC no longer exists', async () => {
    const service = createService({ pvcNotFound: true });
    await expect(
      service.forPvc('kubeconfig', 'app-example', 'data'),
    ).resolves.toMatchObject({ supported: false });
  });

  it('is unsupported when the PVC has no StorageClass', async () => {
    const service = createService({ storageClassName: '' });
    await expect(
      service.forPvc('kubeconfig', 'app-example', 'data'),
    ).resolves.toMatchObject({ supported: false });
  });

  it('is unsupported when the StorageClass no longer exists', async () => {
    const service = createService({ storageClassNotFound: true });
    await expect(
      service.forPvc('kubeconfig', 'app-example', 'data'),
    ).resolves.toMatchObject({ supported: false });
  });
});
