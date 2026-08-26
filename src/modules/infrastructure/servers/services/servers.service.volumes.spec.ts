// The service pulls in the provider graph, which reaches ESM-only packages
// Jest cannot load. Stub them: none is exercised here.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ServersService } from './servers.service';

type VolumeSummary = {
  volumeId: string;
  name: string;
  sizeGb: number;
  attachedServerId?: string | null;
};

describe('ServersService.resolveExistingAttachedVolumes', () => {
  function make(volumes: VolumeSummary[] | Error) {
    const service = new ServersService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const warnings: string[] = [];
    (service as unknown as { logger: { warn: (m: unknown) => void } }).logger =
      {
        warn: (m: unknown) => {
          warnings.push(String(m));
        },
      } as never;

    const providerService = {
      listFluiManagedVolumes: jest
        .fn()
        .mockImplementation(async () =>
          volumes instanceof Error ? Promise.reject(volumes) : volumes,
        ),
    };

    const resolve = (serverId: string, requested?: Array<{ name: string }>) =>
      (
        service as unknown as {
          resolveExistingAttachedVolumes: (
            p: unknown,
            s: string,
            r?: Array<{ name: string }>,
          ) => Promise<Array<{ volumeId: string; sizeGb: number }> | undefined>;
        }
      ).resolveExistingAttachedVolumes(providerService, serverId, requested);

    return { resolve, warnings, providerService };
  }

  const scalewayVolume: VolumeSummary = {
    // Scaleway lists a volume as `<zone>:<uuid>`...
    volumeId: 'fr-par-1:vol-uuid',
    name: 'cluster-a-flui-shared',
    sizeGb: 50,
    // ...and reports the server it hangs off as the bare uuid.
    attachedServerId: 'srv-uuid',
  };

  it('recognises a Scaleway volume attached to the server being created', async () => {
    const { resolve } = make([scalewayVolume]);
    // Flui carries the Scaleway server id in its zoned, family-prefixed form.
    await expect(
      resolve('instance:fr-par-1:srv-uuid', [
        { name: 'cluster-a-flui-shared' },
      ]),
    ).resolves.toEqual([{ volumeId: 'fr-par-1:vol-uuid', sizeGb: 50 }]);
  });

  it('recognises the volume when both sides are bare, as on Hetzner', async () => {
    const { resolve } = make([
      {
        volumeId: '99',
        name: 'cluster-a-flui-shared',
        sizeGb: 50,
        attachedServerId: '12345',
      },
    ]);
    await expect(
      resolve('12345', [{ name: 'cluster-a-flui-shared' }]),
    ).resolves.toEqual([{ volumeId: '99', sizeGb: 50 }]);
  });

  it('refuses when a volume with the requested name exists but hangs off another server', async () => {
    const { resolve } = make([
      { ...scalewayVolume, attachedServerId: 'other-srv-uuid' },
    ]);
    await expect(
      resolve('instance:fr-par-1:srv-uuid', [
        { name: 'cluster-a-flui-shared' },
      ]),
    ).rejects.toThrow(/not attached to it/);
  });

  it('refuses when a volume with the requested name exists unattached', async () => {
    const { resolve } = make([{ ...scalewayVolume, attachedServerId: null }]);
    await expect(
      resolve('instance:fr-par-1:srv-uuid', [
        { name: 'cluster-a-flui-shared' },
      ]),
    ).rejects.toThrow(/cluster-a-flui-shared/);
  });

  it('refuses when the server id carries no readable identity', async () => {
    const { resolve } = make([scalewayVolume]);
    await expect(
      resolve('instance:fr-par-1:', [{ name: 'cluster-a-flui-shared' }]),
    ).rejects.toThrow(/unreadable/);
  });

  it('does not refuse when the volume was never created, and says so', async () => {
    const { resolve, warnings } = make([]);
    await expect(
      resolve('instance:fr-par-1:srv-uuid', [
        { name: 'cluster-a-flui-shared' },
      ]),
    ).resolves.toBeUndefined();
    expect(warnings.join('\n')).toMatch(/do not exist/);
  });

  it('stays best-effort when the provider has no Volume API', async () => {
    const { resolve } = make([]);
    await expect(
      (
        new ServersService(
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        ) as unknown as {
          resolveExistingAttachedVolumes: (
            p: unknown,
            s: string,
            r?: Array<{ name: string }>,
          ) => Promise<unknown>;
        }
      ).resolveExistingAttachedVolumes({}, 'instance:fr-par-1:srv-uuid', [
        { name: 'cluster-a-flui-shared' },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      resolve('instance:fr-par-1:srv-uuid', undefined),
    ).resolves.toBeUndefined();
  });

  it('stays best-effort when the provider listing itself fails', async () => {
    const { resolve, warnings } = make(new Error('scaleway down'));
    await expect(
      resolve('instance:fr-par-1:srv-uuid', [
        { name: 'cluster-a-flui-shared' },
      ]),
    ).resolves.toBeUndefined();
    expect(warnings.join('\n')).toMatch(/Could not resolve existing Volumes/);
  });
});
