// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; this service reaches it only through the billing estimator, injected
// as a stub here, so nothing it defines is ever called.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { BadRequestException } from '@nestjs/common';
import { QuickSetupService } from './quick-setup.service';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ProvisionerReadiness } from '../../storage/interfaces/object-storage-provisioner.interface';

type ReadinessMap = Partial<
  Record<StorageBackendProvider, ProvisionerReadiness>
>;

const READY: ProvisionerReadiness = { ready: true };

function notConnected(provider: string): ProvisionerReadiness {
  return {
    ready: false,
    reason: `CONNECT_${provider}_REQUIRED`,
    message: `${provider} non collegato.`,
  };
}

function build(clusterProvider: CloudProvider, readiness: ReadinessMap) {
  const cluster = { id: 'c1', provider: clusterProvider };
  const clusterRepo = { findOne: jest.fn().mockResolvedValue(cluster) };
  const opRepo = {
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({ id: 'op1' }),
  };
  const provisionerFactory = {
    forProvider: jest.fn((p: StorageBackendProvider) =>
      readiness[p]
        ? { isReady: jest.fn().mockResolvedValue(readiness[p]) }
        : null,
    ),
  };
  const billing = {
    estimateClusterMonthlyCost: jest
      .fn()
      .mockResolvedValue({ clusterMonthlyCents: 0 }),
    estimateBackupMonthlyCost: jest
      .fn()
      .mockResolvedValue({ totalCentsPerMonth: 0 }),
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new QuickSetupService(
    clusterRepo as never,
    opRepo as never,
    provisionerFactory as never,
    billing as never,
    queue as never,
  );
  return { service, queue };
}

describe('QuickSetupService — choosing where backups go', () => {
  const SCW = StorageBackendProvider.SCALEWAY_OBJECT_STORAGE;
  const OVH = StorageBackendProvider.OVH_OBJECT_STORAGE;

  it('never places backups on the cluster’s own cloud', async () => {
    const { service } = build(CloudProvider.SCALEWAY, {
      [SCW]: READY,
      [OVH]: READY,
    });

    const options = await service.getSetupOptions('u1', 'c1');

    expect(options.primary.provider).toBe(OVH);
    expect(options.primary.ready).toBe(true);
  });

  it('keeps Scaleway for a cluster hosted elsewhere', async () => {
    const { service } = build(CloudProvider.HETZNER, {
      [SCW]: READY,
      [OVH]: READY,
    });

    const options = await service.getSetupOptions('u1', 'c1');

    expect(options.primary.provider).toBe(SCW);
  });

  it('falls through to OVH when Scaleway is not connected', async () => {
    const { service } = build(CloudProvider.HETZNER, {
      [SCW]: notConnected('SCALEWAY'),
      [OVH]: READY,
    });

    const options = await service.getSetupOptions('u1', 'c1');

    expect(options.primary.provider).toBe(OVH);
    expect(options.primary.ready).toBe(true);
  });

  it('asks the user to connect a provider when none is ready', async () => {
    const { service } = build(CloudProvider.HETZNER, {
      [SCW]: notConnected('SCALEWAY'),
      [OVH]: notConnected('OVH'),
    });

    const options = await service.getSetupOptions('u1', 'c1');

    expect(options.primary.ready).toBe(false);
    // Any provider's connect reason must raise the flag, not Scaleway's alone.
    expect(options.primary.needsConnection).toBe(true);
  });

  it('refuses to start a setup that has nowhere safe to write', async () => {
    const { service } = build(CloudProvider.OVH, {
      [SCW]: notConnected('SCALEWAY'),
      [OVH]: READY,
    });

    await expect(
      service.startQuickSetup('u1', 'c1', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('honours an explicit choice over the preference order', async () => {
    const { service, queue } = build(CloudProvider.HETZNER, {
      [SCW]: READY,
      [OVH]: READY,
    });

    await service.startQuickSetup('u1', 'c1', {
      primaryProvider: OVH,
    } as never);

    expect(queue.add).toHaveBeenCalledWith(
      'quick-setup',
      expect.objectContaining({ primaryProvider: OVH }),
    );
  });

  it('refuses an explicit choice that sits on the cluster’s own cloud', async () => {
    const { service } = build(CloudProvider.SCALEWAY, {
      [SCW]: READY,
      [OVH]: READY,
    });

    await expect(
      service.startQuickSetup('u1', 'c1', { primaryProvider: SCW } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an explicit choice that is not connected', async () => {
    const { service } = build(CloudProvider.HETZNER, {
      [SCW]: READY,
      [OVH]: notConnected('OVH'),
    });

    await expect(
      service.startQuickSetup('u1', 'c1', { primaryProvider: OVH } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists every destination the cluster may use, so a client can offer a choice', async () => {
    const { service } = build(CloudProvider.SCALEWAY, {
      [SCW]: READY,
      [OVH]: READY,
    });

    const options = await service.getSetupOptions('u1', 'c1');

    // Scaleway is the cluster's own cloud, so it is not on the menu at all.
    expect(options.eligible.map((e) => e.provider)).toEqual([OVH]);
  });

  it('queues the job against the selected provider, not a hardcoded one', async () => {
    const { service, queue } = build(CloudProvider.SCALEWAY, {
      [SCW]: READY,
      [OVH]: READY,
    });

    await service.startQuickSetup('u1', 'c1', {} as never);

    expect(queue.add).toHaveBeenCalledWith(
      'quick-setup',
      expect.objectContaining({ primaryProvider: OVH }),
    );
  });
});
