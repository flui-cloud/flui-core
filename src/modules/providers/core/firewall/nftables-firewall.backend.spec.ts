import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NftablesFirewallBackend } from './nftables-firewall.backend';
import { CloudProvider } from '../../enums/cloud-provider.enum';

/**
 * resolveTargets is the SSH-endpoint resolver the host-firewall backend uses to
 * reach each node. These tests lock in the BYOS port/user resolution (the live
 * finding: a non-:22 host with no explicit byos.host used to fall back to :22).
 */
describe('NftablesFirewallBackend.resolveTargets', () => {
  const build = (cluster: any) => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(cluster),
    };
    const backend = new NftablesFirewallBackend(
      repo as any,
      {} as any,
      {} as any,
    );
    // private method — exercised directly
    return (backend as any).resolveTargets('c1') as Promise<
      Array<{ host: string; port: number; user: string }>
    >;
  };

  it('BYOS: uses byos.port/user with the node IP as host (no byos.host)', async () => {
    const targets = await build({
      provider: CloudProvider.BYOS,
      masterIpAddress: '127.0.0.1',
      nodes: [{ ipAddress: '127.0.0.1' }],
      metadata: {
        byos: { port: 2222, user: 'root' },
        source: 'bootstrap-seeder',
      },
    });
    expect(targets).toEqual([{ host: '127.0.0.1', port: 2222, user: 'root' }]);
  });

  it("BYOS: a node's own ipAddress wins; cluster byos supplies port/user", async () => {
    const targets = await build({
      provider: CloudProvider.BYOS,
      masterIpAddress: '10.0.0.5',
      nodes: [{ ipAddress: '10.0.0.5' }],
      metadata: { byos: { host: 'vps.example', port: 2022, user: 'admin' } },
    });
    // host comes from the node; the cluster byos.host is only a fallback for a
    // node with no address. port/user default from the cluster byos.
    expect(targets).toEqual([{ host: '10.0.0.5', port: 2022, user: 'admin' }]);
  });

  it('BYOS multi-node: per-node byos coords win (master :2222, worker :2223)', async () => {
    const targets = await build({
      provider: CloudProvider.BYOS,
      masterIpAddress: '127.0.0.1',
      nodes: [
        { ipAddress: '127.0.0.1', nodeType: 'master', metadata: {} },
        {
          ipAddress: '127.0.0.1',
          nodeType: 'worker',
          metadata: { byos: { host: '127.0.0.1', port: 2223, user: 'root' } },
        },
      ],
      metadata: { byos: { port: 2222, user: 'root' } },
    });
    expect(targets).toEqual([
      { host: '127.0.0.1', port: 2222, user: 'root' },
      { host: '127.0.0.1', port: 2223, user: 'root' },
    ]);
  });

  it('BYOS: no byos metadata → node IP on :22 as root (real public-VPS case)', async () => {
    const targets = await build({
      provider: CloudProvider.BYOS,
      masterIpAddress: '203.0.113.9',
      nodes: [],
      metadata: { source: 'bootstrap-seeder' },
    });
    expect(targets).toEqual([{ host: '203.0.113.9', port: 22, user: 'root' }]);
  });

  it('other host-firewall provider (contabo): node IPs on :22', async () => {
    const targets = await build({
      provider: CloudProvider.CONTABO,
      masterIpAddress: '1.2.3.4',
      nodes: [{ ipAddress: '1.2.3.4' }, { ipAddress: '1.2.3.5' }],
      metadata: {},
    });
    expect(targets).toEqual([
      { host: '1.2.3.4', port: 22, user: 'root' },
      { host: '1.2.3.5', port: 22, user: 'root' },
    ]);
  });

  it('throws when the cluster has no reachable endpoint', async () => {
    await expect(
      build({
        provider: CloudProvider.BYOS,
        masterIpAddress: null,
        nodes: [],
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * deriveInternalCidrs builds the wholesale-accept list for the input chain. The
 * k3s pod/service ranges are always present; node-to-node traffic is added from
 * an explicit metadata.byos.nodeNetwork and from each node's real private IP, so
 * a multi-node host-firewall cluster never fences a worker off the master API.
 */
describe('NftablesFirewallBackend.deriveInternalCidrs', () => {
  const derive = (cluster: any): string[] => {
    const backend = new NftablesFirewallBackend(
      {} as any,
      {} as any,
      {} as any,
    );
    return (backend as any).deriveInternalCidrs(cluster) as string[];
  };

  it('always keeps the k3s pod + service CIDRs', () => {
    const cidrs = derive({ metadata: {}, nodes: [] });
    expect(cidrs).toEqual(
      expect.arrayContaining(['10.42.0.0/16', '10.43.0.0/16']),
    );
  });

  it('adds an explicit byos.nodeNetwork CIDR (string)', () => {
    const cidrs = derive({
      metadata: { byos: { nodeNetwork: '10.89.0.0/24' } },
      nodes: [],
    });
    expect(cidrs).toContain('10.89.0.0/24');
  });

  it('accepts a comma list and an array for byos.nodeNetwork', () => {
    expect(
      derive({
        metadata: { byos: { nodeNetwork: '10.0.0.0/24, 10.1.0.0/24' } },
        nodes: [],
      }),
    ).toEqual(expect.arrayContaining(['10.0.0.0/24', '10.1.0.0/24']));
    expect(
      derive({
        metadata: { byos: { nodeNetwork: ['192.168.1.0/24'] } },
        nodes: [],
      }),
    ).toContain('192.168.1.0/24');
  });

  it("adds each node's private IP as a /32, skipping loopback/link-local", () => {
    const cidrs = derive({
      metadata: {},
      nodes: [
        { privateIp: '10.89.0.2' },
        { privateIp: '10.89.0.3' },
        { privateIp: '127.0.0.1' },
        { privateIp: '169.254.1.1' },
      ],
    });
    expect(cidrs).toEqual(
      expect.arrayContaining(['10.89.0.2/32', '10.89.0.3/32']),
    );
    expect(cidrs).not.toContain('127.0.0.1/32');
    expect(cidrs).not.toContain('169.254.1.1/32');
  });

  it('ignores a malformed nodeNetwork value', () => {
    const cidrs = derive({
      metadata: { byos: { nodeNetwork: 'not-a-cidr' } },
      nodes: [],
    });
    expect(cidrs).toEqual(['10.42.0.0/16', '10.43.0.0/16']);
  });
});

describe('NftablesFirewallBackend.toReachabilityError', () => {
  const backend = new NftablesFirewallBackend({} as any, {} as any, {} as any);
  const target = { host: '127.0.0.1', port: 2222, user: 'root' };
  const map = (msg: string) =>
    (backend as any).toReachabilityError(new Error(msg), target) as Error;

  it.each([
    'SSH exec failed (code 255): ssh: connect to host 127.0.0.1 port 22: Connection refused',
    'Connection timed out',
    'ssh: Could not resolve hostname foo',
    'Permission denied (publickey)',
  ])('maps unreachable ssh failure to 503: %s', (msg) => {
    const err = map(msg);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toContain('127.0.0.1:2222');
    expect(err.message).toContain('SSH connection settings');
  });

  it('passes a genuine command failure through unchanged (not a 503)', () => {
    const err = map('nft: syntax error near line 4');
    expect(err).not.toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toContain('syntax error');
  });
});
