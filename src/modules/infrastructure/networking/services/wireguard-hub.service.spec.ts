import { WireGuardHubService } from './wireguard-hub.service';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { KEY_MARKER, READY_MARKER } from '../wireguard-host';

const KEY_A = 'h0FoHrdl/fI6kj27RRzbjxQQEqb1Iibt/b3oYbknZtE=';

const cluster = (nodes: any[]) => ({
  id: 'c1',
  provider: 'hetzner',
  masterIpAddress: '1.1.1.1',
  metadata: {},
  nodes,
});

describe('WireGuardHubService', () => {
  describe('ensureControlEnd', () => {
    /** The overlay is a network; an operator looking for it looks in VNet
     *  management. Installations built before the overlay have no such row, so
     *  recording it belongs on the loop rather than at install time. */
    it('records the Flui network row on every pass', async () => {
      const vnets = { ensureFluiNetwork: jest.fn() };
      const svc = new WireGuardHubService(
        {
          findOne: jest.fn().mockResolvedValue(
            cluster([
              {
                id: 'm',
                ipAddress: '1.1.1.1',
                metadata: {},
                nodeType: 'master',
              },
            ]),
          ),
        } as any,
        {
          ensureControlPeer: jest
            .fn()
            .mockResolvedValue({ managementIp: '10.250.0.1' }),
          renderControlConfig: jest.fn().mockResolvedValue('[Interface]\n'),
          markHandshake: jest.fn(),
        } as any,
        {
          apply: jest
            .fn()
            .mockResolvedValue(`${KEY_MARKER}=${KEY_A}\n${READY_MARKER}`),
          run: jest.fn().mockResolvedValue(''),
        } as any,
        new ManagementAddressResolver(),
        vnets as any,
      );

      await svc.ensureControlEnd();

      expect(vnets.ensureFluiNetwork).toHaveBeenCalled();
    });
  });

  describe('revokeOrphanPeers', () => {
    const build2 = (clusterRows: any[], peerSvc: any) =>
      new WireGuardHubService(
        { find: jest.fn().mockResolvedValue(clusterRows) } as any,
        peerSvc as any,
        {} as any,
        new ManagementAddressResolver(),
        { ensureFluiNetwork: jest.fn() } as any,
      );

    it('withdraws the members of a cluster that no longer exists', async () => {
      // A destroyed cluster is never reconciled again, so its members would
      // stay on the hub for good — routed, and holding addresses the pool can
      // never hand out again.
      const revokeMember = jest.fn();
      const svc = build2(
        [{ id: 'live' }, { id: 'gone', deletedAt: new Date() }],
        {
          livePeers: jest.fn().mockResolvedValue([
            { clusterId: 'live', nodeId: 'n1' },
            { clusterId: 'gone', nodeId: 'n2' },
          ]),
          revokeMember,
        },
      );

      expect(await svc.revokeOrphanPeers()).toBe(1);
      expect(revokeMember).toHaveBeenCalledWith('n2');
      expect(revokeMember).not.toHaveBeenCalledWith('n1');
    });

    it('withdraws a peer whose cluster row is gone altogether', async () => {
      const revokeMember = jest.fn();
      const svc = build2([{ id: 'live' }], {
        livePeers: jest
          .fn()
          .mockResolvedValue([{ clusterId: 'vanished', nodeId: 'n3' }]),
        revokeMember,
      });

      expect(await svc.revokeOrphanPeers()).toBe(1);
      expect(revokeMember).toHaveBeenCalledWith('n3');
    });

    it('does nothing when no cluster comes back at all', async () => {
      // An empty answer is "the query told us nothing", not "everything is
      // gone" — acting on it would dismantle the whole overlay.
      const revokeMember = jest.fn();
      const svc = build2([], {
        livePeers: jest
          .fn()
          .mockResolvedValue([{ clusterId: 'live', nodeId: 'n1' }]),
        revokeMember,
      });

      expect(await svc.revokeOrphanPeers()).toBe(0);
      expect(revokeMember).not.toHaveBeenCalled();
    });

    it('leaves the control peer alone', async () => {
      // It carries no nodeId, and it is the hub itself.
      const revokeMember = jest.fn();
      const svc = build2([{ id: 'ctl' }], {
        livePeers: jest
          .fn()
          .mockResolvedValue([{ clusterId: 'ctl', nodeId: null }]),
        revokeMember,
      });

      await svc.revokeOrphanPeers();

      expect(revokeMember).not.toHaveBeenCalled();
    });
  });
});
