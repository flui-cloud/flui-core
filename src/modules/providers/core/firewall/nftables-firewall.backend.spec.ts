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
      { find: jest.fn().mockResolvedValue([]) } as any,
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
 * an explicit metadata.byos.nodeNetwork, from each node's real private IP, and
 * from the environment VNet subnet the cluster is attached to — without that
 * last one a single-node workload cluster drops the control cluster on a
 * policy-drop input chain (live finding: ping ok, TCP/6443 refused).
 */
/**
 * The renderer has accepted `wgInterface`/`wgOnlyPorts` from the start and no
 * caller ever passed them, so the tunnel was never a trusted ingress and every
 * rule had to name a source address instead — which cannot follow the control
 * when the path moves. These read the ruleset the backend actually ships.
 */
describe('the ruleset the backend ships', () => {
  const shipped = async () => {
    let sent = '';
    const hostCommand = {
      run: jest.fn().mockImplementation(async (_t: unknown, script: string) => {
        const b64 = /echo '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)?.[1];
        if (b64) sent = Buffer.from(b64, 'base64').toString('utf-8');
        return 'FLUI_NFT_APPLIED';
      }),
    };
    const backend = new NftablesFirewallBackend(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'c1',
          provider: CloudProvider.BYOS,
          masterIpAddress: '10.0.0.1',
          nodes: [{ ipAddress: '10.0.0.1' }],
          metadata: { byos: { user: 'root' } },
        }),
      } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      hostCommand as any,
    );
    await backend.createFirewall({
      name: 'f',
      rules: [],
      labels: [{ key: 'flui-cluster-id', value: 'c1' }],
    } as any);
    return sent;
  };

  it('admits the API server over the tunnel, by interface and not by address', async () => {
    expect(await shipped()).toContain('iifname "flui0" tcp dport 6443 accept');
  });

  it('admits the telemetry a workload pushes back, over the tunnel', async () => {
    // The ingest ports sit inside the NodePort range the ruleset refuses on
    // principle. Right for a public address, wrong for a peer the tunnel has
    // already authenticated — without this a workload's telemetry is dropped at
    // the control cluster's own ingress.
    const ruleset = await shipped();
    expect(ruleset).toContain('iifname "flui0" tcp dport 30100 accept');
    expect(ruleset).toContain('iifname "flui0" tcp dport 30428 accept');
  });

  it('refuses to carry traffic between two overlay peers', async () => {
    expect(await shipped()).toContain('iifname "flui0" oifname "flui0" drop');
  });
});

/**
 * The value reconciliation uses to decide whether an already-configured host
 * still has the right ruleset. It has to move for anything that changes what
 * the host receives — the whole reason the ruleset improvement that prompted it
 * reached nobody was that the comparison only ever looked at the rules.
 */
describe('the fingerprint of what a host would be sent', () => {
  const backendFor = (cluster: any) =>
    new NftablesFirewallBackend(
      { findOne: jest.fn().mockResolvedValue(cluster) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      { run: jest.fn() } as any,
    );

  const cluster = {
    id: 'c1',
    provider: CloudProvider.BYOS,
    masterIpAddress: '10.0.0.1',
    nodes: [{ ipAddress: '10.0.0.1' }],
    metadata: { byos: { user: 'root' } },
  };

  const rules = [
    {
      description: 'https',
      direction: 'in' as const,
      protocol: 'tcp' as const,
      port: '443',
      sourceIps: ['0.0.0.0/0'],
    },
  ];

  const print = (c: any = cluster) =>
    backendFor(c).payloadFingerprint('nft-c1', rules);

  afterEach(() => delete process.env.FLUI_OBS_INGEST_NODEPORTS);

  it('is stable while nothing about the payload changes', async () => {
    expect(await print()).toBe(await print());
  });

  it('moves when what the tunnel is trusted with changes', async () => {
    // No rule mentions these ports, so the rules hash cannot notice them.
    const before = await print();
    process.env.FLUI_OBS_INGEST_NODEPORTS = '30100';
    expect(await print()).not.toBe(before);
  });

  it('moves when the rules themselves change', async () => {
    const other = await backendFor(cluster).payloadFingerprint('nft-c1', [
      { ...rules[0], port: '8443' },
    ]);
    expect(other).not.toBe(await print());
  });

  it('answers nothing rather than guessing when the cluster cannot be read', async () => {
    // Nothing compares equal to nothing, so the decision falls back to the
    // rules — where it was before this existed.
    const backend = new NftablesFirewallBackend(
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      { run: jest.fn() } as any,
    );
    expect(await backend.payloadFingerprint('nft-c1', rules)).toBeUndefined();
  });
});

describe('NftablesFirewallBackend.deriveInternalCidrs', () => {
  const derive = (cluster: any, subnets: any[] = []): Promise<string[]> => {
    const subnetRepo = { find: jest.fn().mockResolvedValue(subnets) };
    const backend = new NftablesFirewallBackend(
      {} as any,
      subnetRepo as any,
      {} as any,
    );
    return (backend as any).deriveInternalCidrs(cluster) as Promise<string[]>;
  };

  it('always keeps the k3s pod + service CIDRs', async () => {
    const cidrs = await derive({ metadata: {}, nodes: [] });
    expect(cidrs).toEqual(
      expect.arrayContaining(['10.42.0.0/16', '10.43.0.0/16']),
    );
  });

  it('adds an explicit byos.nodeNetwork CIDR (string)', async () => {
    const cidrs = await derive({
      metadata: { byos: { nodeNetwork: '10.89.0.0/24' } },
      nodes: [],
    });
    expect(cidrs).toContain('10.89.0.0/24');
  });

  it('accepts a comma list and an array for byos.nodeNetwork', async () => {
    expect(
      await derive({
        metadata: { byos: { nodeNetwork: '10.0.0.0/24, 10.1.0.0/24' } },
        nodes: [],
      }),
    ).toEqual(expect.arrayContaining(['10.0.0.0/24', '10.1.0.0/24']));
    expect(
      await derive({
        metadata: { byos: { nodeNetwork: ['192.168.1.0/24'] } },
        nodes: [],
      }),
    ).toContain('192.168.1.0/24');
  });

  it("adds each node's private IP as a /32, skipping loopback/link-local", async () => {
    const cidrs = await derive({
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

  it('ignores a malformed nodeNetwork value', async () => {
    const cidrs = await derive({
      metadata: { byos: { nodeNetwork: 'not-a-cidr' } },
      nodes: [],
    });
    expect(cidrs).toEqual(['10.42.0.0/16', '10.43.0.0/16']);
  });

  it('adds the VNet subnet range from the node vnetAttachment (peers get in)', async () => {
    const cidrs = await derive(
      {
        id: 'workload-5',
        metadata: {},
        nodes: [
          {
            privateIp: '10.10.1.85',
            metadata: {
              vnetAttachment: { vnetId: 'vnet-1', subnetId: 'subnet-1' },
            },
          },
        ],
      },
      [{ id: 'subnet-1', ipRange: '10.10.1.0/24' }],
    );
    // the control cluster (10.10.1.69) is now inside an accepted source range
    expect(cidrs).toContain('10.10.1.0/24');
    expect(cidrs).toContain('10.10.1.85/32');
  });

  it('adds the VNet subnet range from cluster metadata.vnetConfig', async () => {
    const cidrs = await derive(
      {
        id: 'c1',
        metadata: { vnetConfig: { vnetId: 'vnet-1', subnetId: 'subnet-1' } },
        nodes: [],
      },
      [{ id: 'subnet-1', ipRange: '10.10.1.0/24' }],
    );
    expect(cidrs).toContain('10.10.1.0/24');
  });

  it('falls back to the VNet subnets when only a vnetId is recorded', async () => {
    const cidrs = await derive(
      {
        id: 'c1',
        metadata: { vnetConfig: { vnetId: 'vnet-1' } },
        nodes: [],
      },
      [{ id: 's', ipRange: '10.10.2.0/24' }],
    );
    expect(cidrs).toContain('10.10.2.0/24');
  });

  it('falls back to the VNet when the recorded subnetId no longer resolves', async () => {
    const subnetRepo = {
      find: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 's', ipRange: '10.10.3.0/24' }]),
    };
    const backend = new NftablesFirewallBackend(
      {} as any,
      subnetRepo as any,
      {} as any,
    );
    const cidrs = await (backend as any).deriveInternalCidrs({
      id: 'c1',
      metadata: { vnetConfig: { vnetId: 'vnet-1', subnetId: 'stale' } },
      nodes: [],
    });
    expect(cidrs).toContain('10.10.3.0/24');
    expect(subnetRepo.find).toHaveBeenCalledTimes(2);
  });

  it('never widens to 0.0.0.0/0 from a bogus subnet range', async () => {
    const cidrs = await derive(
      {
        id: 'c1',
        metadata: { vnetConfig: { subnetId: 'subnet-1' } },
        nodes: [],
      },
      [{ id: 'subnet-1', ipRange: '0.0.0.0/0' }],
    );
    expect(cidrs).toEqual(['10.42.0.0/16', '10.43.0.0/16']);
  });

  it('degrades to the previous behaviour when the subnet lookup throws', async () => {
    const subnetRepo = {
      find: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const backend = new NftablesFirewallBackend(
      {} as any,
      subnetRepo as any,
      {} as any,
    );
    const cidrs = await (backend as any).deriveInternalCidrs({
      id: 'c1',
      metadata: { vnetConfig: { subnetId: 'subnet-1' } },
      nodes: [{ privateIp: '10.10.1.85' }],
    });
    expect(cidrs).toEqual(['10.42.0.0/16', '10.43.0.0/16', '10.10.1.85/32']);
  });

  it('does not query at all when the cluster has no VNet reference', async () => {
    const subnetRepo = { find: jest.fn() };
    const backend = new NftablesFirewallBackend(
      {} as any,
      subnetRepo as any,
      {} as any,
    );
    await (backend as any).deriveInternalCidrs({
      id: 'c1',
      metadata: {},
      nodes: [{ privateIp: '10.10.1.85' }],
    });
    expect(subnetRepo.find).not.toHaveBeenCalled();
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
