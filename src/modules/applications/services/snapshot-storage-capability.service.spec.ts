jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: class {},
  StorageV1Api: class {},
  CustomObjectsApi: class {},
}));

import {
  decideSnapshotCapability,
  SnapshotStorageSignals,
  SnapshotStorageCapabilityService,
} from './snapshot-storage-capability.service';

describe('decideSnapshotCapability', () => {
  it.each(['rancher.io/local-path', 'flui.cloud/local-path'])(
    'marks the non-CSI provisioner %s as unsupported',
    (provisioner) => {
      expect(
        decideSnapshotCapability({
          provisioner,
          volumeSnapshotClassDrivers: [],
        }),
      ).toEqual({
        supported: false,
        reason:
          "Snapshots are not available because this cluster's storage class does not use a CSI driver.",
      });
    },
  );

  it('supports a CSI provisioner with a matching VolumeSnapshotClass without consulting a cloud provider', () => {
    const signals: SnapshotStorageSignals = {
      provisioner: 'driver.longhorn.io',
      volumeSnapshotClassDrivers: ['driver.longhorn.io'],
    };

    expect(decideSnapshotCapability(signals)).toEqual({ supported: true });
    expect(Object.keys(signals)).not.toContain('provider');
  });

  it('marks a CSI provisioner as unsupported when the VolumeSnapshot API is absent', () => {
    expect(
      decideSnapshotCapability({
        provisioner: 'rbd.csi.ceph.com',
        volumeSnapshotClassDrivers: null,
      }),
    ).toEqual({
      supported: false,
      reason:
        'Snapshots are not available because the cluster does not have the Kubernetes VolumeSnapshot API installed.',
    });
  });
});

describe('SnapshotStorageCapabilityService', () => {
  function createService(options: {
    storageClassName: string;
    provisioner: string;
    volumeSnapshotClassDrivers?: string[];
  }): {
    service: SnapshotStorageCapabilityService;
    listClusterCustomObject: jest.Mock;
  } {
    const coreApi = {
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        spec: { storageClassName: options.storageClassName },
      }),
    };
    const storageApi = {
      readStorageClass: jest.fn().mockResolvedValue({
        provisioner: options.provisioner,
      }),
    };
    const listClusterCustomObject = jest.fn().mockResolvedValue({
      items: (options.volumeSnapshotClassDrivers ?? []).map((driver) => ({
        driver,
      })),
    });
    const makeApiClient = jest
      .fn()
      .mockReturnValueOnce(coreApi)
      .mockReturnValueOnce(storageApi)
      .mockReturnValueOnce({ listClusterCustomObject });
    const service = new SnapshotStorageCapabilityService({
      makeKubeConfig: jest.fn().mockReturnValue({ makeApiClient }),
    } as any);

    return { service, listClusterCustomObject };
  }

  it('resolves a local-path StorageClass as unsupported without querying snapshot classes', async () => {
    const { service, listClusterCustomObject } = createService({
      storageClassName: 'local-path',
      provisioner: 'rancher.io/local-path',
    });

    await expect(
      service.forPvc('kubeconfig', 'app-example', 'data'),
    ).resolves.toMatchObject({ supported: false });
    expect(listClusterCustomObject).not.toHaveBeenCalled();
  });

  it('resolves a CSI StorageClass with a matching VolumeSnapshotClass as supported', async () => {
    const { service } = createService({
      storageClassName: 'longhorn',
      provisioner: 'driver.longhorn.io',
      volumeSnapshotClassDrivers: ['driver.longhorn.io'],
    });

    await expect(
      service.forPvc('kubeconfig', 'app-example', 'data'),
    ).resolves.toEqual({ supported: true });
  });
});
