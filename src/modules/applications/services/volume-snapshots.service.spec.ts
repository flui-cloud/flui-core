jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { VolumeSnapshotsService } from './volume-snapshots.service';

describe('VolumeSnapshotsService capability gate', () => {
  const unsupported = {
    supported: false,
    reason:
      "Snapshots are not available because this cluster's storage class does not use a CSI driver.",
  };

  let service: VolumeSnapshotsService;
  let volumeExportService: {
    capabilities: Record<string, unknown>;
    listExports: jest.Mock;
  };
  let snapshotStorageCapability: { forPvc: jest.Mock };
  let runner: { run: jest.Mock };

  beforeEach(() => {
    const clusterRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'cluster-1',
        provider: CloudProvider.BYOS,
        kubeconfigEncrypted: 'encrypted',
      }),
    };
    const applicationsRepository = {
      findById: jest.fn().mockResolvedValue({
        id: 'app-1',
        slug: 'example',
        clusterId: 'cluster-1',
        k8sNamespace: 'app-example',
      }),
    };
    const appResourcesRepository = {
      findByApplicationId: jest.fn().mockResolvedValue([
        {
          kind: ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
          name: 'data',
        },
      ]),
    };
    const volumeClaims = {
      resolveForApplication: jest.fn().mockResolvedValue([
        {
          name: 'data',
          namespace: 'app-example',
          requested: null,
          requestedBytes: 0,
          storageClass: 'flui-local',
          phase: 'Bound',
          attributedBy: 'tracked-resource',
        },
      ]),
    };
    volumeExportService = {
      capabilities: {},
      listExports: jest.fn().mockResolvedValue([
        {
          exportId: 'snapshot-1',
          sink: 'pvc-clone',
          namespace: 'app-example',
          sourcePvcName: 'data',
          createdAt: '2026-08-16T00:00:00.000Z',
          ready: true,
        },
      ]),
    };
    snapshotStorageCapability = {
      forPvc: jest.fn().mockResolvedValue(unsupported),
    };
    runner = { run: jest.fn() };

    const copyLedger = { record: jest.fn().mockResolvedValue(null) };
    const preflight = {
      check: jest.fn().mockResolvedValue({
        facts: { quiesce: 'none', writersAtStart: 0 },
        paused: [],
      }),
    };
    const pauseLease = { release: jest.fn().mockResolvedValue(undefined) };

    service = new VolumeSnapshotsService(
      clusterRepository as any,
      applicationsRepository as any,
      appResourcesRepository as any,
      volumeClaims as any,
      copyLedger as any,
      preflight as any,
      pauseLease as any,
      volumeExportService as any,
      snapshotStorageCapability as any,
      { decrypt: jest.fn().mockReturnValue('kubeconfig') } as any,
      runner as any,
    );
  });

  it('returns an unsupported capability response instead of throwing for a BYOS application', async () => {
    await expect(service.listForApp('app-1')).resolves.toEqual({
      ...unsupported,
      items: [],
    });
    expect(volumeExportService.listExports).not.toHaveBeenCalled();
  });

  it('refuses create, restore and delete with the storage capability reason', async () => {
    await expect(
      service.createForApp({ applicationId: 'app-1' }),
    ).rejects.toEqual(new BadRequestException(unsupported.reason));
    await expect(service.restoreForApp('app-1', 'snapshot-1')).rejects.toEqual(
      new BadRequestException(unsupported.reason),
    );
    await expect(service.deleteForApp('app-1', 'snapshot-1')).rejects.toEqual(
      new BadRequestException(unsupported.reason),
    );
    expect(runner.run).not.toHaveBeenCalled();
  });
});
