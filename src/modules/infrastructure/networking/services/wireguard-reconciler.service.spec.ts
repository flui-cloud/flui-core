import { WireGuardReconciler } from './wireguard-reconciler.service';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import {
  KEY_MARKER,
  READY_MARKER,
  UNSUPPORTED_MARKER,
} from '../wireguard-host';

const KEY_A = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';
const KEY_B = '+8PaqoF8+RnCIQLKaVflCPpr7escUSccTYpZLkW2JN0=';

const cluster = (nodes: any[]) => ({
  id: 'c1',
  provider: 'hetzner',
  masterIpAddress: '1.1.1.1',
  metadata: {},
  nodes,
});

describe('WireGuardReconciler', () => {
  let hub: { applyControlConfig: jest.Mock };
  beforeEach(() => {
    hub = { applyControlConfig: jest.fn() };
  });

  const build = (clusterRow: any, host: any, peerSvc: any = {}) =>
    new WireGuardReconciler(
      { findOne: jest.fn().mockResolvedValue(clusterRow) } as any,
      {
        enrolMember: jest
          .fn()
          .mockResolvedValue({ managementIp: '10.250.0.2' }),
        renderConfigFor: jest.fn().mockResolvedValue('[Interface]\n'),
        managedSubnetId: jest.fn().mockResolvedValue(undefined),
        markHandshake: jest.fn(),
        ...peerSvc,
      } as any,
      host as any,
      hub as any,
    );

  describe('enrolCluster', () => {
    it('records the key each node returns', async () => {
      const apply = jest
        .fn()
        .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`);
      const enrolMember = jest
        .fn()
        .mockResolvedValue({ managementIp: '10.250.0.2' });
      const svc = build(
        cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]),
        { apply },
        { enrolMember },
      );

      const [outcome] = await svc.enrolCluster('c1');

      expect(outcome).toMatchObject({
        nodeId: 'n1',
        publicKey: KEY_A,
        managementIp: '10.250.0.2',
      });
      expect(enrolMember).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'n1', publicKey: KEY_A }),
      );
    });

    it('enrols a node into the Flui-built network its cluster sits on', async () => {
      const apply = jest
        .fn()
        .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`);
      const enrolMember = jest
        .fn()
        .mockResolvedValue({ managementIp: '10.200.1.1' });
      const row = cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]);
      row.metadata = { vnetConfig: { subnetId: 'sub-a' } };
      const svc = build(
        row,
        { apply },
        {
          enrolMember,
          managedSubnetId: jest.fn().mockResolvedValue('sub-a'),
        },
      );

      await svc.enrolCluster('c1');

      expect(enrolMember).toHaveBeenCalledWith(
        expect.objectContaining({ subnetId: 'sub-a' }),
      );
    });

    it('leaves a provider-built network to its provider', async () => {
      // BYOS can be either, so the answer comes from the VNet rather than from
      // the provider name — and a subnet Flui did not build yields nothing.
      const apply = jest
        .fn()
        .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`);
      const enrolMember = jest
        .fn()
        .mockResolvedValue({ managementIp: '10.250.0.2' });
      const row = cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]);
      row.metadata = { vnetConfig: { subnetId: 'sub-hetzner' } };
      const svc = build(
        row,
        { apply },
        {
          enrolMember,
          managedSubnetId: jest.fn().mockResolvedValue(undefined),
        },
      );

      await svc.enrolCluster('c1');

      expect(enrolMember).toHaveBeenCalledWith(
        expect.objectContaining({ subnetId: undefined }),
      );
    });

    it('carries on after a node that fails, and says which', async () => {
      // A cluster where three of four nodes enrol is more useful than one where
      // none did, so the failure is reported rather than thrown.
      const apply = jest
        .fn()
        .mockResolvedValueOnce(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`)
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValueOnce(`${KEY_MARKER}=${KEY_B}\n${READY_MARKER}`);
      const svc = build(
        cluster([
          { id: 'n1', ipAddress: '1.1.1.1', metadata: {} },
          { id: 'n2', ipAddress: '2.2.2.2', metadata: {} },
          { id: 'n3', ipAddress: '3.3.3.3', metadata: {} },
        ]),
        { apply },
      );

      const outcomes = await svc.enrolCluster('c1');

      expect(outcomes).toHaveLength(3);
      expect(outcomes[1]).toMatchObject({
        host: '2.2.2.2',
        error: expect.stringContaining('connection refused'),
      });
      expect(outcomes[2].publicKey).toBe(KEY_B);
    });

    it('marks a host that cannot run WireGuard instead of failing it', async () => {
      const apply = jest
        .fn()
        .mockResolvedValue(`${UNSUPPORTED_MARKER}\n${READY_MARKER}`);
      const enrolMember = jest.fn();
      const svc = build(
        cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]),
        { apply },
        { enrolMember },
      );

      const [outcome] = await svc.enrolCluster('c1');

      expect(outcome.unsupported).toBe(true);
      expect(enrolMember).not.toHaveBeenCalled();
    });

    it('never stores output that is not a key', async () => {
      const apply = jest
        .fn()
        .mockResolvedValue(
          `${KEY_MARKER}=wg: command not found\n${READY_MARKER}`,
        );
      const enrolMember = jest.fn();
      const svc = build(
        cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]),
        { apply },
        { enrolMember },
      );

      const [outcome] = await svc.enrolCluster('c1');

      expect(outcome.error).toMatch(/usable public key/);
      expect(enrolMember).not.toHaveBeenCalled();
    });
  });

  describe('applyCluster', () => {
    it('renders per node, so two nodes never share an identity', async () => {
      const apply = jest.fn().mockResolvedValue('FLUI_WG_APPLIED');
      const renderConfigFor = jest.fn().mockResolvedValue('[Interface]\n');
      const svc = build(
        cluster([
          { id: 'n1', ipAddress: '1.1.1.1', metadata: {} },
          { id: 'n2', ipAddress: '2.2.2.2', metadata: {} },
        ]),
        { apply },
        { renderConfigFor },
      );

      await svc.applyCluster('c1');

      expect(renderConfigFor).toHaveBeenCalledTimes(2);
      expect(renderConfigFor).toHaveBeenCalledWith('n1');
      expect(renderConfigFor).toHaveBeenCalledWith('n2');
    });
  });

  describe('node/endpoint pairing', () => {
    it('skips a node with no matching SSH endpoint rather than guessing', async () => {
      // Pushing one node's config to another machine would hand it the wrong
      // identity on the overlay — not worth risking to save a lookup.
      const apply = jest
        .fn()
        .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`);
      const svc = build(
        cluster([
          { id: 'n1', ipAddress: '9.9.9.9', metadata: {} },
          { id: 'ghost', ipAddress: null, metadata: {} },
        ]),
        { apply },
      );
      const outcomes = await svc.enrolCluster('c1');
      expect(outcomes.map((o) => o.host)).toEqual(['9.9.9.9']);
      expect(outcomes.map((o) => o.nodeId)).not.toContain('ghost');
      expect(apply).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconcileCluster', () => {
    const peersOf = (rows: any[]) => ({
      livePeers: jest.fn().mockResolvedValue(rows),
      revokeMember: jest.fn(),
      enrolMember: jest.fn().mockResolvedValue({ managementIp: '10.250.0.2' }),
      renderMemberConfig: jest.fn().mockResolvedValue('[Interface]\n'),
      markHandshake: jest.fn(),
    });

    it('withdraws peers of nodes that no longer exist', async () => {
      // A departed node must stop being routable straight away, not linger in
      // everyone's config until some later pass notices.
      const peerSvc = peersOf([
        { clusterId: 'c1', nodeId: 'gone', managementIp: '10.250.0.9' },
        { clusterId: 'c1', nodeId: 'n1', managementIp: '10.250.0.2' },
      ]);
      const svc = build(
        cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]),
        {
          apply: jest
            .fn()
            .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`),
        },
        peerSvc,
      );

      const result = await svc.reconcileCluster('c1');

      expect(peerSvc.revokeMember).toHaveBeenCalledWith('gone');
      expect(peerSvc.revokeMember).not.toHaveBeenCalledWith('n1');
      expect(result.revoked).toBe(1);
    });

    it('leaves another cluster’s peers alone', async () => {
      const peerSvc = peersOf([
        { clusterId: 'other', nodeId: 'x', managementIp: '10.250.0.5' },
      ]);
      const svc = build(
        cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]),
        {
          apply: jest
            .fn()
            .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`),
        },
        peerSvc,
      );

      await svc.reconcileCluster('c1');

      expect(peerSvc.revokeMember).not.toHaveBeenCalled();
    });

    /**
     * The hub's config is written at the top of a sweep, before any member has
     * been asked for a key. A node enrolled further down the same sweep is
     * therefore absent from it, and stays unreachable from the control until
     * the next one — ten minutes of silence on a node that is otherwise ready.
     */
    it('rewrites the hub’s own config as soon as a node presents a key', async () => {
      const svc = build(
        cluster([
          { id: 'n1', ipAddress: '1.1.1.1', metadata: {}, nodeType: 'master' },
        ]),
        {
          apply: jest
            .fn()
            .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`),
        },
        peersOf([]),
      );

      await svc.reconcileCluster('c1');

      expect(hub.applyControlConfig).toHaveBeenCalled();
    });

    it('leaves the hub alone when no node presented one', async () => {
      // Nothing changed at the hub, and it is an SSH round trip per sweep.
      const svc = build(
        cluster([
          { id: 'n1', ipAddress: '1.1.1.1', metadata: {}, nodeType: 'master' },
        ]),
        { apply: jest.fn().mockResolvedValue(UNSUPPORTED_MARKER) },
        peersOf([]),
      );

      await svc.reconcileCluster('c1');

      expect(hub.applyControlConfig).not.toHaveBeenCalled();
    });

    it('reports what happened rather than throwing on a bad node', async () => {
      const peerSvc = peersOf([]);
      const svc = build(
        cluster([
          { id: 'n1', ipAddress: '1.1.1.1', metadata: {} },
          { id: 'n2', ipAddress: '2.2.2.2', metadata: {} },
        ]),
        {
          apply: jest
            .fn()
            .mockResolvedValueOnce(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`)
            .mockRejectedValueOnce(new Error('connection refused'))
            .mockResolvedValue('FLUI_WG_APPLIED'),
        },
        peerSvc,
      );

      const result = await svc.reconcileCluster('c1');

      expect(result.enrolled).toBe(1);
      expect(
        result.failed.some((f) => /connection refused/.test(f.error ?? '')),
      ).toBe(true);
    });

    it('is safe to run twice — the second pass changes nothing new', async () => {
      // The property that lets the same call sit on node creation, node removal
      // and a periodic sweep without three code paths.
      const peerSvc = peersOf([
        { clusterId: 'c1', nodeId: 'n1', managementIp: '10.250.0.2' },
      ]);
      const svc = build(
        cluster([{ id: 'n1', ipAddress: '1.1.1.1', metadata: {} }]),
        {
          apply: jest
            .fn()
            .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`),
        },
        peerSvc,
      );

      const first = await svc.reconcileCluster('c1');
      const second = await svc.reconcileCluster('c1');

      expect(first.revoked).toBe(0);
      expect(second.revoked).toBe(0);
      expect(second.enrolled).toBe(first.enrolled);
    });
  });
});
