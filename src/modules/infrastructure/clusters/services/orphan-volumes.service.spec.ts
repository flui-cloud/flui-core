import { ConflictException, NotFoundException } from '@nestjs/common';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { OrphanVolumesService } from './orphan-volumes.service';

/**
 * Decision 131. This service deletes paid-for disks, so what is worth proving
 * is not that it deletes — it is everything it REFUSES to delete.
 *
 * The load-bearing one is the first: Scaleway addresses a volume as
 * `<zone>:<uuid>` when it lists and takes the bare uuid elsewhere, Flui's
 * registry holds whichever form the path that wrote it happened to have, and a
 * raw string comparison between the two answers "not ours" about the shared
 * storage of a live cluster.
 */

const ZONED = 'fr-par-1:8a1f2c00-0000-4000-8000-000000000001';
const BARE = '8a1f2c00-0000-4000-8000-000000000001';

const volume = (over: Partial<any> = {}) => ({
  volumeId: ZONED,
  name: 'flui-shared-storage',
  sizeGb: 50,
  region: 'fr-par-1',
  attachedServerId: null,
  labels: { 'managed-by': 'flui-cloud' },
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const build = (opts: {
  clusters?: Array<{ sharedStorageVolumeId?: string | null }>;
  volumes?: any[];
  listThrows?: boolean;
  noList?: boolean;
  noDelete?: boolean;
}) => {
  const deleted: string[] = [];
  const detached: string[] = [];
  const provider: any = {
    listFluiManagedVolumes: jest.fn(async () => {
      if (opts.listThrows) throw new Error('token f00 rejected by fr-par-1');
      return opts.volumes ?? [];
    }),
    detachVolume: jest.fn(async (id: string) => {
      detached.push(id);
      return {};
    }),
    deleteVolume: jest.fn(async (id: string) => {
      deleted.push(id);
    }),
  };
  if (opts.noList) delete provider.listFluiManagedVolumes;
  if (opts.noDelete) delete provider.deleteVolume;

  const repo: any = { find: jest.fn(async () => opts.clusters ?? []) };
  const factory: any = { getProvider: jest.fn(() => provider) };
  const service = new OrphanVolumesService(repo, factory);
  return { service, deleted, detached, provider };
};

describe('deleting a volume no cluster points at', () => {
  /**
   * THE proof. Registry and provider disagree on the spelling; they are the
   * same disk; the disk belongs to a cluster that is alive; nothing is deleted.
   */
  it('refuses the live cluster volume when the registry holds the zoned form and the caller the bare one', async () => {
    const { service, deleted } = build({
      clusters: [{ sharedStorageVolumeId: ZONED }],
      volumes: [volume({ volumeId: BARE })],
    });

    await expect(service.cleanup(CloudProvider.SCALEWAY, BARE)).rejects.toThrow(
      /still referenced by an existing cluster/,
    );
    expect(deleted).toEqual([]);
  });

  it('refuses it the other way round too — bare in the registry, zoned at the door', async () => {
    const { service, deleted } = build({
      clusters: [{ sharedStorageVolumeId: BARE }],
      volumes: [volume({ volumeId: ZONED })],
    });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, ZONED),
    ).rejects.toThrow(ConflictException);
    expect(deleted).toEqual([]);
  });

  /**
   * The second fence. Nothing in the registry claims this volume, so by
   * difference it looks free — but a server is holding it, and this call
   * removes no server.
   */
  it('refuses a volume still attached to a server, instead of printing it and going on', async () => {
    const { service, deleted, detached } = build({
      clusters: [],
      volumes: [volume({ attachedServerId: 'a1b2c3' })],
    });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, ZONED),
    ).rejects.toThrow(/still attached to server a1b2c3/);
    expect(deleted).toEqual([]);
    expect(detached).toEqual([]);
  });

  it('refuses a volume the provider does not report back', async () => {
    const { service, deleted } = build({
      clusters: [],
      volumes: [volume({ volumeId: 'fr-par-1:some-other-uuid' })],
    });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, ZONED),
    ).rejects.toThrow(NotFoundException);
    expect(deleted).toEqual([]);
  });

  it('refuses when the provider cannot be read at all, rather than assuming the volume is free', async () => {
    const { service, deleted } = build({ clusters: [], listThrows: true });

    const failure = service.cleanup(CloudProvider.SCALEWAY, ZONED);
    await expect(failure).rejects.toThrow(/cannot be verified/);
    // The provider's own message can carry account detail; it must not come
    // back out through the API.
    await expect(failure).rejects.not.toThrow(/token f00/);
    expect(deleted).toEqual([]);
  });

  it('refuses when the provider cannot list its volumes, so the state is unknowable', async () => {
    const { service, deleted } = build({ clusters: [], noList: true });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, ZONED),
    ).rejects.toThrow(/cannot be verified/);
    expect(deleted).toEqual([]);
  });

  it('refuses when more than one volume answers to the id', async () => {
    const { service, deleted } = build({
      clusters: [],
      volumes: [volume({ volumeId: ZONED }), volume({ volumeId: BARE })],
    });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, ZONED),
    ).rejects.toThrow(/More than one/);
    expect(deleted).toEqual([]);
  });

  it('refuses an id it cannot read', async () => {
    const { service, deleted } = build({ clusters: [], volumes: [volume()] });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, 'fr-par-1:'),
    ).rejects.toThrow(/cannot be read/);
    expect(deleted).toEqual([]);
  });

  it('reports rather than deletes when the provider has no delete primitive', async () => {
    const { service, deleted } = build({
      clusters: [],
      volumes: [volume()],
      noDelete: true,
    });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, ZONED),
    ).resolves.toEqual({
      deleted: false,
      message: 'Provider scaleway has no deleteVolume primitive',
    });
    expect(deleted).toEqual([]);
  });

  it('deletes a detached volume that no cluster claims, detaching first', async () => {
    const { service, deleted, detached } = build({
      clusters: [{ sharedStorageVolumeId: 'fr-par-1:another-uuid' }],
      volumes: [volume()],
    });

    await expect(
      service.cleanup(CloudProvider.SCALEWAY, ZONED),
    ).resolves.toEqual({
      deleted: true,
      message: `Deleted ${ZONED} from scaleway`,
    });
    expect(detached).toEqual([ZONED]);
    expect(deleted).toEqual([ZONED]);
  });

  it('still deletes a plain Hetzner numeric id, which has no zone to differ about', async () => {
    const { service, deleted } = build({
      clusters: [{ sharedStorageVolumeId: '999' }],
      volumes: [volume({ volumeId: '102938', region: 'fsn1' })],
    });

    await expect(
      service.cleanup(CloudProvider.HETZNER, '102938'),
    ).resolves.toMatchObject({ deleted: true });
    expect(deleted).toEqual(['102938']);
  });
});

describe('listing the volumes no cluster points at', () => {
  it('does not call a live cluster volume an orphan because the spellings differ', async () => {
    const { service } = build({
      clusters: [{ sharedStorageVolumeId: BARE }],
      volumes: [volume({ volumeId: ZONED })],
    });

    await expect(service.scan([CloudProvider.SCALEWAY])).resolves.toEqual([]);
  });

  it('still lists a volume nothing claims, marking the attachment it carries', async () => {
    const { service } = build({
      clusters: [],
      volumes: [volume({ attachedServerId: 'a1b2c3' })],
    });

    await expect(service.scan([CloudProvider.SCALEWAY])).resolves.toMatchObject(
      [{ volumeId: ZONED, attached: true, attachedServerId: 'a1b2c3' }],
    );
  });
});
