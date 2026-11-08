jest.mock('@kubernetes/client-node', () => ({}));

import { HetznerProviderService } from './hetzner-provider.service';

describe('HetznerProviderService.resolveSSHKeys', () => {
  function build(listed: Array<{ id: number; name: string; labels: object }>) {
    const service = Object.create(
      HetznerProviderService.prototype,
    ) as HetznerProviderService;
    const listSshKeys = jest.fn().mockResolvedValue({
      data: { ssh_keys: listed, meta: { pagination: { last_page: 1 } } },
    });
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      createSSHKey: jest
        .fn()
        .mockRejectedValue(
          new Error(
            'SSH key with name flui-bootstrap-x already exists on Hetzner',
          ),
        ),
      createSSHKeysApi: jest.fn().mockResolvedValue({ listSshKeys }),
    });
    return { service, listSshKeys };
  }

  it('finds the key another server registered a moment earlier, labels or not', async () => {
    const { service, listSshKeys } = build([
      { id: 42, name: 'flui-bootstrap-x', labels: {} },
    ]);

    await expect(
      service.resolveSSHKeys([
        {
          name: 'flui-bootstrap-x',
          publicKey: 'ssh-ed25519 AAA',
          fingerprint: 'f',
        },
      ] as never),
    ).resolves.toEqual(['42']);
    expect(listSshKeys).toHaveBeenCalledWith(undefined, 'flui-bootstrap-x');
  });

  it('still fails when no key of that name is there', async () => {
    const { service } = build([]);

    await expect(
      service.resolveSSHKeys([
        {
          name: 'flui-bootstrap-x',
          publicKey: 'ssh-ed25519 AAA',
          fingerprint: 'f',
        },
      ] as never),
    ).rejects.toThrow('already exists');
  });
});
