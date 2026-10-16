jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterOrchestrationService } from './cluster-orchestration.service';
import { ClusterType } from '../entities/cluster.entity';

type Plan = {
  address?: string;
  mode: 'overlay' | 'mesh';
  peers: unknown[];
  control?: unknown;
};

describe('what a new node is told about the Flui network', () => {
  const handshake = {
    publicKey: 'k-master',
    address: '10.250.0.1',
    endpoint: '1.1.1.1:51821',
    others: [
      {
        publicKey: 'k-worker',
        address: '10.250.0.2',
        endpoint: '2.2.2.2:51821',
      },
    ],
  };

  const build = () => {
    const wgPeers = {
      managedSubnetId: jest.fn().mockResolvedValue(undefined),
      reserveAddress: jest
        .fn()
        .mockResolvedValue({ managementIp: '10.250.0.9' }),
      bootstrapPeersFor: jest.fn().mockResolvedValue([]),
      controlHandshakeDetails: jest.fn().mockResolvedValue(handshake),
    };
    const service = Object.create(
      ClusterOrchestrationService.prototype,
    ) as ClusterOrchestrationService;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      wgPeers,
    });
    const plan = (cluster: unknown, nodeId = 'n1') =>
      (
        service as unknown as {
          overlayPlanFor: (c: unknown, id: string) => Promise<Plan>;
        }
      ).overlayPlanFor(cluster, nodeId);
    return { plan, wgPeers };
  };

  beforeEach(() => {
    process.env.FLUI_WG_ENABLED = 'true';
  });
  afterEach(() => {
    process.env.FLUI_WG_ENABLED = 'false';
  });

  it('gives a workload node the master as its control and every other control node as a peer', async () => {
    const { plan } = build();
    await expect(
      plan({ id: 'wl', clusterType: ClusterType.WORKLOAD, metadata: {} }),
    ).resolves.toEqual({
      address: '10.250.0.9',
      mode: 'overlay',
      peers: handshake.others,
      control: {
        publicKey: 'k-master',
        address: '10.250.0.1',
        endpoint: '1.1.1.1:51821',
      },
    });
  });

  it('reserves no member address for a control node and tells it to dial nobody: the hub sets it up once it joined', async () => {
    const { plan, wgPeers } = build();
    await expect(
      plan({ id: 'ctl', clusterType: ClusterType.CONTROL, metadata: {} }),
    ).resolves.toEqual({ mode: 'overlay', peers: [] });
    expect(wgPeers.reserveAddress).not.toHaveBeenCalled();
    expect(wgPeers.controlHandshakeDetails).not.toHaveBeenCalled();
  });
});
