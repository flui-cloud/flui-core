import {
  HostLayerBlockedError,
  NftablesFirewallBackend,
} from './nftables-firewall.backend';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { SSH_VIA_CONTROL_RULE } from './nftables-ruleset';
import { FirewallRule } from '../../interfaces/firewall-provider.interface';

const workload = (overrides: Record<string, unknown> = {}) => ({
  id: 'wc1',
  provider: CloudProvider.HETZNER,
  clusterType: 'workload',
  masterIpAddress: '203.0.113.10',
  metadata: { vnetConfig: { vnetId: 'v1', subnetId: 's1' } },
  nodes: [
    {
      id: 'n1',
      serverName: 'wc1-master',
      ipAddress: '203.0.113.10',
      privateIp: '10.0.1.2',
    },
    {
      id: 'n2',
      serverName: 'wc1-worker-1',
      ipAddress: '203.0.113.11',
      privateIp: '10.0.1.3',
    },
  ],
  ...overrides,
});

const build = (
  cluster: unknown,
  subnets: unknown[] = [{ id: 's1', ipRange: '10.0.1.0/24' }],
  run: jest.Mock = jest.fn(async (_t: unknown, script: string) =>
    script.includes('FLUI_NFT_PRESENT')
      ? 'FLUI_NFT_PRESENT\n'
      : 'FLUI_NFT_APPLIED\n',
  ),
) => {
  const backend = new NftablesFirewallBackend(
    { findOne: jest.fn().mockResolvedValue(cluster) } as any,
    { find: jest.fn().mockResolvedValue(subnets) } as any,
    { run } as any,
  );
  return { backend, run };
};

const appliedRuleset = (run: jest.Mock): string => {
  const script = run.mock.calls
    .map((c) => c[1] as string)
    .find((s) => s.includes('FLUI_NFT_APPLIED'));
  const b64 = /echo '([^']+)' \| base64 -d/.exec(script ?? '')?.[1] ?? '';
  return Buffer.from(b64, 'base64').toString('utf-8');
};

const rules: FirewallRule[] = [
  {
    description: 'HTTPS',
    direction: 'in',
    protocol: 'tcp',
    port: '443',
    sourceIps: ['0.0.0.0/0', '::/0'],
  },
  {
    description: 'flui:xprovider:apiserver',
    direction: 'in',
    protocol: 'tcp',
    port: '6443',
    sourceIps: ['198.51.100.7/32'],
  },
  {
    description: SSH_VIA_CONTROL_RULE,
    direction: 'in',
    protocol: 'tcp',
    port: '22',
    sourceIps: ['198.51.100.7/32'],
  },
];

describe('the host firewall beneath a provider firewall', () => {
  describe('when it is safe to apply', () => {
    it('is safe with the private subnet known and every node on it', async () => {
      const { backend } = build(workload());
      await expect(backend.hostLayerBlocker('wc1')).resolves.toBeNull();
    });

    it('is not safe without a private network: node-to-node traffic would be cut', async () => {
      const { backend } = build(workload({ metadata: {} }), []);
      await expect(backend.hostLayerBlocker('wc1')).resolves.toMatch(
        /private network/,
      );
    });

    it('is not safe when the only subnet on record opens to anyone', async () => {
      const { backend } = build(workload(), [
        { id: 's1', ipRange: '0.0.0.0/0' },
      ]);
      await expect(backend.hostLayerBlocker('wc1')).resolves.toMatch(
        /private network/,
      );
    });

    it('is not safe when a node of several has no private address', async () => {
      const cluster = workload();
      (cluster.nodes as Array<{ privateIp?: string }>)[1].privateIp = '';
      const { backend } = build(cluster);
      await expect(backend.hostLayerBlocker('wc1')).resolves.toMatch(
        /wc1-worker-1/,
      );
    });

    it('is not safe before any node exists', async () => {
      const { backend } = build(workload({ nodes: [], masterIpAddress: null }));
      await expect(backend.hostLayerBlocker('wc1')).resolves.toMatch(
        /no reachable node/,
      );
    });
  });

  describe('applying it', () => {
    it('refuses, and touches no node, when the gate is closed', async () => {
      const { backend, run } = build(workload({ metadata: {} }), []);
      await expect(backend.applyHostLayer('wc1', rules)).rejects.toBeInstanceOf(
        HostLayerBlockedError,
      );
      expect(run).not.toHaveBeenCalled();
    });

    it('names the nodes without nftables and applies to none of them', async () => {
      const run = jest.fn(async (target: { host: string }, script: string) => {
        if (script.includes('FLUI_NFT_PRESENT'))
          return target.host === '203.0.113.11'
            ? 'FLUI_NFT_MISSING\n'
            : 'FLUI_NFT_PRESENT\n';
        return 'FLUI_NFT_APPLIED\n';
      });
      const { backend } = build(workload(), undefined, run);
      const failure = backend.applyHostLayer('wc1', rules);
      await expect(failure).rejects.toBeInstanceOf(HostLayerBlockedError);
      await expect(failure).rejects.toThrow(/203\.0\.113\.11/);
      expect(
        run.mock.calls.some((c) => String(c[1]).includes('FLUI_NFT_APPLIED')),
      ).toBe(false);
    });

    it('applies to every node and says how many', async () => {
      const { backend, run } = build(workload());
      await expect(backend.applyHostLayer('wc1', rules)).resolves.toBe(2);
      const applied = run.mock.calls.filter((c) =>
        String(c[1]).includes('echo FLUI_NFT_APPLIED'),
      );
      expect(applied.map((c) => c[0].host)).toEqual([
        '203.0.113.10',
        '203.0.113.11',
      ]);
    });

    it('renders the Flui network rules exactly as on a host-firewall workload', async () => {
      const { backend, run } = build(workload());
      await backend.applyHostLayer('wc1', rules);
      const ruleset = appliedRuleset(run);
      expect(ruleset).toContain('policy drop;');
      expect(ruleset).toContain('ip saddr 10.0.1.0/24 accept');
      expect(ruleset).toContain(
        'ip saddr { 198.51.100.7/32 } tcp dport 6443 accept comment "flui:xprovider:apiserver"',
      );
      expect(ruleset).toContain(
        'ip saddr { 198.51.100.7/32 } tcp dport 22 accept comment "ssh from the control"',
      );
      expect(ruleset).toContain('iifname "flui0" tcp dport 22 accept');
      expect(ruleset).toContain('iifname "flui0" tcp dport 6443 accept');
      expect(ruleset).not.toContain('ssh anti-lockout');
      expect(ruleset).not.toMatch(/dport 2049/);
      expect(ruleset).not.toMatch(/dport 8472/);
    });
  });

  describe('its fingerprint', () => {
    it('moves when a node joins, so the new sibling is written into every node', async () => {
      const before = await build(workload()).backend.hostLayerFingerprint(
        'wc1',
        rules,
      );
      const grown = workload();
      (grown.nodes as unknown[]).push({
        id: 'n3',
        serverName: 'wc1-worker-2',
        ipAddress: '203.0.113.12',
        privateIp: '10.0.1.4',
      });
      const after = await build(grown).backend.hostLayerFingerprint(
        'wc1',
        rules,
      );
      expect(before).toBeDefined();
      expect(after).not.toEqual(before);
    });

    it('moves when a peer rule changes', async () => {
      const { backend } = build(workload());
      const a = await backend.hostLayerFingerprint('wc1', rules);
      const b = await backend.hostLayerFingerprint('wc1', rules.slice(0, 1));
      expect(a).not.toEqual(b);
    });
  });
});
