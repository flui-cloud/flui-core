jest.mock('@kubernetes/client-node', () => ({}));

import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { FirewallsService } from './firewalls.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('FirewallsService.describeClusterFirewall', () => {
  const make = (opts: {
    current?: object | null;
    legacy?: object | null;
    live?: object | null | Error;
  }) => {
    const backend = {
      getFirewall: jest.fn(async () => {
        if (opts.live instanceof Error) throw opts.live;
        return opts.live ?? null;
      }),
    };
    const service = new FirewallsService(
      { findOne: jest.fn(async () => opts.legacy ?? null) } as any,
      { findOne: jest.fn(async () => opts.current ?? null) } as any,
      { getFirewallProvider: () => backend } as any,
      {} as any,
    );
    return { service, backend };
  };

  it('reads a cluster created since firewalls moved to their own table, with servers counted by the provider', async () => {
    const { service } = make({
      current: {
        providerFirewallId: '123',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      live: {
        id: '123',
        name: 'flui-workload-1',
        rules: [{ direction: 'in', protocol: 'tcp', port: '443' }],
        labels: {},
        appliedTo: [{ serverId: 'a' }, { serverId: 'b' }],
      },
    });
    await expect(
      service.describeClusterFirewall('c1', CloudProvider.HETZNER),
    ).resolves.toMatchObject({ id: '123', appliedToServerCount: 2 });
  });

  it('falls back to the old table', async () => {
    const { service } = make({
      legacy: {
        id: 'l1',
        name: 'old',
        provider: 'hetzner',
        rules: [],
        appliedToServerIds: ['a'],
      },
    });
    await expect(
      service.describeClusterFirewall('c1', CloudProvider.HETZNER),
    ).resolves.toMatchObject({ id: 'l1', appliedToServerCount: 1 });
  });

  it('answers 404, not 500, when the cluster has no firewall', async () => {
    const { service } = make({});
    await expect(
      service.describeClusterFirewall('c1', CloudProvider.HETZNER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('says the provider could not be read instead of inventing a count', async () => {
    const { service } = make({
      current: { providerFirewallId: '123' },
      live: new Error('timeout'),
    });
    await expect(
      service.describeClusterFirewall('c1', CloudProvider.HETZNER),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
