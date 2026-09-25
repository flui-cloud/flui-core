jest.mock('@kubernetes/client-node', () => ({}));

import { AccessService } from './access.service';

function service(
  retrieve: () => Promise<string>,
  keyPath = 'system/1/private.key',
) {
  const repository = {
    findKeyById: jest.fn().mockResolvedValue({
      id: 'key-1',
      publicKey: 'ssh-ed25519 AAAA',
      keyPath,
    }),
  };
  const keyStorage = {
    retrievePrivateKey: jest.fn(retrieve),
    isStoredHere: jest.fn((path: string) => !path.startsWith('/elsewhere')),
  };
  const clusters = {
    findOneBy: jest
      .fn()
      .mockResolvedValue({ id: 'c1', bootstrapKeyId: 'key-1' }),
  };
  const none = {} as never;
  return new AccessService(
    repository as never,
    keyStorage as never,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    clusters as never,
  );
}

describe("a cluster's bootstrap key", () => {
  it('is handed back whole while its private half is on disk', async () => {
    const material = await service(
      async () => 'PRIVATE',
    ).getBootstrapKeyMaterialForCluster('c1');
    expect(material).toEqual({
      id: 'key-1',
      publicKey: 'ssh-ed25519 AAAA',
      privateKey: 'PRIVATE',
    });
  });

  it('counts as absent once its private half is gone, so a new one is minted instead of every add failing', async () => {
    const gone = Object.assign(new Error('ENOENT: no such file'), {
      code: 'ENOENT',
    });
    const material = await service(() =>
      Promise.reject(gone),
    ).getBootstrapKeyMaterialForCluster('c1');
    expect(material).toBeNull();
  });

  it('still fails on anything but a missing file — a key that will not open is not a key to replace silently', async () => {
    const sealed = new Error('unable to authenticate data');
    await expect(
      service(() => Promise.reject(sealed)).getBootstrapKeyMaterialForCluster(
        'c1',
      ),
    ).rejects.toThrow('unable to authenticate data');
  });

  it('counts as absent when another installation keeps it, instead of refusing to add a node', async () => {
    const retrieve = jest.fn();
    const material = await service(
      retrieve,
      '/elsewhere/keys/system/1/private.key',
    ).getBootstrapKeyMaterialForCluster('c1');
    expect(material).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
  });
});
