import {
  AddressableCluster,
  AddressableNode,
  ManagementAddressResolver,
} from './management-address.resolver';

const cluster = (
  over: Partial<AddressableCluster> = {},
): AddressableCluster => ({
  name: 'c',
  provider: 'hetzner',
  masterIpAddress: '1.2.3.4',
  masterPrivateIp: '10.0.1.5',
  metadata: { vnetConfig: { vnetId: 'v1', subnetId: 's1' } },
  ...over,
});

const node = (over: Partial<AddressableNode> = {}): AddressableNode => ({
  ipAddress: '5.6.7.8',
  privateIp: '10.0.1.9',
  ...over,
});

describe('ManagementAddressResolver', () => {
  let r: ManagementAddressResolver;

  beforeEach(() => {
    r = new ManagementAddressResolver();
  });

  describe('sharesPrivateNetwork', () => {
    it('is true for the same provider, VNet and subnet', () => {
      expect(r.sharesPrivateNetwork(cluster(), cluster())).toBe(true);
    });

    it('is false across providers even with identical VNet ids', () => {
      expect(
        r.sharesPrivateNetwork(cluster({ provider: 'scaleway' }), cluster()),
      ).toBe(false);
    });

    it('is false for different VNets on the same provider', () => {
      expect(
        r.sharesPrivateNetwork(
          cluster({ metadata: { vnetConfig: { vnetId: 'v2' } } }),
          cluster(),
        ),
      ).toBe(false);
    });

    it('is false for different subnets when both pin one', () => {
      expect(
        r.sharesPrivateNetwork(
          cluster({
            metadata: { vnetConfig: { vnetId: 'v1', subnetId: 's2' } },
          }),
          cluster(),
        ),
      ).toBe(false);
    });

    it('is true when only one side pins a subnet', () => {
      expect(
        r.sharesPrivateNetwork(
          cluster({ metadata: { vnetConfig: { vnetId: 'v1' } } }),
          cluster(),
        ),
      ).toBe(true);
    });

    it('is false when either side has no VNet recorded — an absent VNet is not a shared one', () => {
      expect(r.sharesPrivateNetwork(cluster({ metadata: {} }), cluster())).toBe(
        false,
      );
      expect(
        r.sharesPrivateNetwork(cluster(), cluster({ metadata: null })),
      ).toBe(false);
    });
  });

  describe('privateNetworkRelation', () => {
    it('separates clusters on different providers', () => {
      expect(
        r.privateNetworkRelation(cluster({ provider: 'ovh' }), cluster()),
      ).toBe('separate');
    });

    it('separates same-provider clusters on different VNets', () => {
      expect(
        r.privateNetworkRelation(
          cluster({ metadata: { vnetConfig: { vnetId: 'v2' } } }),
          cluster(),
        ),
      ).toBe('separate');
    });

    it('reports unknown — not separate — when a VNet was never recorded', () => {
      expect(
        r.privateNetworkRelation(cluster({ metadata: {} }), cluster()),
      ).toBe('unknown');
    });
  });

  describe('an unrecorded VNet is not proof of separation', () => {
    // A control cluster whose VNet seeding failed at boot has no vnetConfig
    // until the bootstrap backfill repairs it, yet its private network works
    // for same-provider peers. Treating that gap as separation moved telemetry
    // onto the control's public address, where the ingest ports are closed by
    // default — logs lost, silently.
    const controlWithoutVnet = () => cluster({ metadata: {} });

    it('keeps telemetry on the private path', () => {
      expect(
        r.controlEndpointFor(cluster(), controlWithoutVnet()),
      ).toMatchObject({ address: '10.0.1.5', path: 'private' });
    });

    it('still bakes the public API-server address into the kubeconfig', () => {
      // The opposite trade: a private endpoint that turns out to be
      // unroutable leaves a cluster unmanageable with no error to follow.
      expect(
        r.apiServerEndpointFor(cluster(), node(), controlWithoutVnet()),
      ).toMatchObject({ address: '5.6.7.8', path: 'public' });
    });

    it('and therefore still demands a public 6443 rule', () => {
      expect(
        r.requiresPublicApiServerRule(cluster(), node(), controlWithoutVnet()),
      ).toBe(true);
    });
  });

  describe('controlEndpointFor', () => {
    it('uses the control private IP when the networks are shared', () => {
      expect(r.controlEndpointFor(cluster(), cluster())).toMatchObject({
        address: '10.0.1.5',
        path: 'private',
      });
    });

    it('uses the control public IP when they are not shared', () => {
      const workload = cluster({ provider: 'scaleway' });
      expect(r.controlEndpointFor(workload, cluster())).toMatchObject({
        address: '1.2.3.4',
        path: 'public',
      });
    });

    it('prefers the operator-declared host for a BYOS control', () => {
      const control = cluster({
        provider: 'byos',
        masterIpAddress: '10.88.0.2',
        masterPrivateIp: null,
        metadata: { byos: { host: '109.123.252.6' } },
      });
      expect(r.controlEndpointFor(cluster(), control)).toMatchObject({
        address: '109.123.252.6',
        path: 'public',
      });
    });

    it('falls back to the public IP when a shared control has no private IP', () => {
      const control = cluster({ masterPrivateIp: null });
      expect(r.controlEndpointFor(cluster(), control)).toMatchObject({
        address: '1.2.3.4',
        path: 'public',
      });
    });

    it('returns undefined when the control has no reachable address at all', () => {
      const control = cluster({ masterIpAddress: null, masterPrivateIp: null });
      expect(
        r.controlEndpointFor(cluster({ provider: 'scaleway' }), control),
      ).toBeUndefined();
    });

    it('does not depend on the node role — master and worker resolve alike', () => {
      const workload = cluster({ provider: 'ovh' });
      const control = cluster();
      const once = r.controlEndpointFor(workload, control);
      const twice = r.controlEndpointFor(workload, control);
      expect(once).toEqual(twice);
      expect(once?.path).toBe('public');
    });
  });

  describe('apiServerEndpointFor', () => {
    it('uses the node private IP on a shared network', () => {
      expect(
        r.apiServerEndpointFor(cluster(), node(), cluster()),
      ).toMatchObject({ address: '10.0.1.9', path: 'private' });
    });

    it('uses the node public IP across providers', () => {
      expect(
        r.apiServerEndpointFor(cluster({ provider: 'ovh' }), node(), cluster()),
      ).toMatchObject({ address: '5.6.7.8', path: 'public' });
    });

    it('uses the node public IP for the same provider on a different VNet', () => {
      const workload = cluster({
        metadata: { vnetConfig: { vnetId: 'v9', subnetId: 's9' } },
      });
      expect(r.apiServerEndpointFor(workload, node(), cluster())).toMatchObject(
        { address: '5.6.7.8', path: 'public' },
      );
    });

    it('falls back to the node IP when no control cluster is resolved', () => {
      expect(r.apiServerEndpointFor(cluster(), node(), null)).toMatchObject({
        address: '10.0.1.9',
        path: 'private',
      });
    });

    it('uses the private IP when the node has no public one', () => {
      expect(
        r.apiServerEndpointFor(
          cluster({ provider: 'ovh' }),
          node({ ipAddress: null }),
          cluster(),
        ),
      ).toMatchObject({ address: '10.0.1.9', path: 'private' });
    });
  });

  describe('the kubeconfig endpoint and the firewall rule never disagree', () => {
    // The defect this resolver exists to prevent: the endpoint baked into the
    // kubeconfig was decided by one predicate and the 6443 firewall rule by
    // another, so a same-provider/different-VNet workload got a public endpoint
    // and no rule opening it — an unmanageable cluster.
    const cases: Array<[string, AddressableCluster]> = [
      ['same provider, same VNet', cluster()],
      [
        'same provider, different VNet',
        cluster({ metadata: { vnetConfig: { vnetId: 'v9' } } }),
      ],
      ['different provider', cluster({ provider: 'scaleway' })],
      ['no VNet recorded', cluster({ metadata: {} })],
    ];

    it.each(cases)('%s', (_label, workload) => {
      const control = cluster();
      const endpoint = r.apiServerEndpointFor(workload, node(), control);
      const needsRule = r.requiresPublicApiServerRule(
        workload,
        node(),
        control,
      );
      expect(needsRule).toBe(endpoint?.path === 'public');
    });
  });

  describe('the management overlay', () => {
    const overlay = { controlAddress: '10.250.0.1', enrolled: true };

    it('carries telemetry for clusters with no shared private network', async () => {
      const w = cluster({ provider: 'ovh' });
      expect(r.controlEndpointFor(w, cluster(), overlay)).toMatchObject({
        address: '10.250.0.1',
        path: 'wireguard',
      });
    });

    it('stays out of the way when a private network already exists', () => {
      // Two clusters on one VNet reach each other for free; routing them
      // through the tunnel would add encapsulation and buy nothing.
      expect(r.controlEndpointFor(cluster(), cluster(), overlay)).toMatchObject(
        {
          path: 'private',
        },
      );
    });

    it('beats a guess when neither side records a VNet', () => {
      // Unknown means the private path is a hope; the tunnel is a known-good
      // path whenever it is actually up.
      expect(
        r.controlEndpointFor(cluster({ metadata: {} }), cluster(), overlay),
      ).toMatchObject({ path: 'wireguard' });
    });

    it('is ignored while the cluster is still being enrolled', () => {
      // An address on a tunnel that is not up yet is unreachable, where the
      // public one still works.
      const w = cluster({ provider: 'ovh' });
      expect(
        r.controlEndpointFor(w, cluster(), { ...overlay, enrolled: false }),
      ).toMatchObject({ path: 'public' });
    });

    it('moves the API server onto the tunnel only when told to', () => {
      const w = cluster({ provider: 'ovh' });
      const node_ = node();
      expect(r.apiServerEndpointFor(w, node_, cluster())).toMatchObject({
        path: 'public',
      });
      expect(
        r.apiServerEndpointFor(w, node_, cluster(), {
          nodeAddress: '10.250.0.7',
          enrolled: true,
        }),
      ).toMatchObject({ address: '10.250.0.7', path: 'wireguard' });
    });

    it('withdraws the public 6443 rule once the API server is on the tunnel', () => {
      // The two must move together: a rule left open is a port nobody closed,
      // and a rule withdrawn too early is a cluster nobody can reach.
      const w = cluster({ provider: 'ovh' });
      const ctx = { nodeAddress: '10.250.0.7', enrolled: true };
      expect(r.requiresPublicApiServerRule(w, node(), cluster())).toBe(true);
      expect(r.requiresPublicApiServerRule(w, node(), cluster(), ctx)).toBe(
        false,
      );
    });
  });
});
