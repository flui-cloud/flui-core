import { BadRequestException } from '@nestjs/common';
import { ClusterType } from '../../clusters/entities/cluster.entity';
import { managementNetworkOn } from '../management-network.state';
import {
  controlEndFailed,
  controlEndHealthy,
  controlEndWarned,
} from '../control-end-health';
import { ManagementNetworkService } from './management-network.service';

const control = (over: Record<string, unknown> = {}) => ({
  id: 'ctl',
  name: 'control',
  clusterType: ClusterType.CONTROL,
  masterIpAddress: '5.6.7.8',
  metadata: {},
  createdAt: new Date(),
  ...over,
});

const make = (
  ctl: ReturnType<typeof control> | null,
  publicAddress?: string,
) => {
  const clusters = {
    find: jest.fn().mockResolvedValue(ctl ? [ctl] : []),
    save: jest.fn(async (row) => row),
  };
  const service = new ManagementNetworkService(
    clusters as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    {
      controlPeers: jest.fn().mockResolvedValue([]),
      livePeers: jest.fn().mockResolvedValue([]),
    } as never,
    { publicAddressOf: () => publicAddress } as never,
  );
  return { service, clusters };
};

describe('the Flui network switch', () => {
  it('stores the choice on the control cluster and applies it at once', async () => {
    const ctl = control();
    const { service, clusters } = make(ctl, '5.6.7.8');
    const status = await service.set(false, 'ada');
    expect(clusters.save).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          managementNetwork: expect.objectContaining({
            enabled: false,
            changedBy: 'ada',
          }),
        }),
      }),
    );
    expect(status).toMatchObject({ enabled: false, source: 'setting' });
    expect(managementNetworkOn()).toBe(false);
  });

  it('refuses to switch on where the control cannot be reached, and says why', async () => {
    const { service } = make(control(), undefined);
    await expect(service.set(true)).rejects.toThrow(BadRequestException);
    await expect(service.set(true)).rejects.toThrow(
      'no address the other clusters can reach',
    );
  });

  it('reads a stored choice back after a restart', async () => {
    const { service } = make(
      control({ metadata: { managementNetwork: { enabled: true } } }),
      '5.6.7.8',
    );
    await service.refresh();
    expect(managementNetworkOn()).toBe(true);
    expect((await service.status()).source).toBe('setting');
  });
});

describe('the members of the Flui network', () => {
  it('lists the clusters outside the control, not the control itself', async () => {
    const ctl = control();
    const service = new ManagementNetworkService(
      {
        find: jest
          .fn()
          .mockResolvedValueOnce([ctl])
          .mockResolvedValueOnce([ctl])
          .mockResolvedValue([
            ctl,
            { id: 'w', name: 'scw', clusterType: ClusterType.WORKLOAD },
          ]),
        save: jest.fn(),
      } as never,
      {
        find: jest
          .fn()
          .mockResolvedValue([{ id: 'n2', serverName: 'scw-master' }]),
      } as never,
      {
        controlPeers: jest.fn().mockResolvedValue([]),
        livePeers: jest.fn().mockResolvedValue([
          {
            role: 'member',
            clusterId: 'ctl',
            nodeId: 'n1',
            managementIp: '10.250.0.14',
            status: 'pending',
          },
          {
            role: 'member',
            clusterId: 'w',
            nodeId: 'n2',
            managementIp: '10.250.0.2',
            status: 'active',
            lastHandshakeAt: new Date('2026-09-26T10:10:00Z'),
          },
        ]),
      } as never,
      { publicAddressOf: () => '5.6.7.8' } as never,
    );
    const { members } = await service.status();
    expect(members).toEqual([
      expect.objectContaining({
        clusterName: 'scw',
        nodeName: 'scw-master',
        status: 'active',
      }),
    ]);
  });
});

describe('why members stay pending', () => {
  afterEach(() => controlEndHealthy());

  it("says what stopped the control's end from being set up", async () => {
    const { service } = make(
      control({ metadata: { managementNetwork: { enabled: true } } }),
      '5.6.7.8',
    );
    controlEndFailed(
      "could not read the control cluster's key: Cannot reach node 5.6.7.8:22 over SSH",
    );
    expect((await service.status()).hubProblem).toContain(
      'Cannot reach node 5.6.7.8:22',
    );
  });

  it('says nothing once the control applies again', async () => {
    const { service } = make(
      control({ metadata: { managementNetwork: { enabled: true } } }),
      '5.6.7.8',
    );
    controlEndFailed('could not apply');
    controlEndHealthy();
    expect((await service.status()).hubProblem).toBeNull();
  });
});

describe('every control node’s end', () => {
  const reading = (fresh: boolean, minutesAgo = 1) => ({
    fresh,
    at: new Date().toISOString(),
    readAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });

  const build = (workerStatus = 'stale') => {
    const ctl = control();
    const primary = {
      id: 'row-m',
      role: 'control',
      nodeId: 'm',
      isPrimary: true,
      managementIp: '10.250.0.1',
      endpointHost: '5.6.7.8',
      listenPort: 51821,
      publicKey: 'k1',
      status: 'active',
    };
    const worker = {
      id: 'row-w',
      role: 'control',
      nodeId: 'w1',
      isPrimary: false,
      managementIp: '10.250.0.2',
      endpointHost: '6.6.6.6',
      listenPort: 51821,
      publicKey: 'k2',
      status: workerStatus,
    };
    const member = {
      id: 'row-x',
      role: 'member',
      clusterId: 'wl',
      nodeId: 'x1',
      managementIp: '10.250.0.3',
      publicKey: 'k3',
      status: 'active',
      controlHandshakes: {
        'row-m': reading(true),
        'row-w': reading(true, 45),
      },
    };
    return new ManagementNetworkService(
      {
        find: jest
          .fn()
          .mockResolvedValueOnce([ctl])
          .mockResolvedValueOnce([ctl])
          .mockResolvedValue([
            ctl,
            {
              id: 'wl',
              name: 'demo',
              clusterType: ClusterType.WORKLOAD,
              metadata: {
                overlayDemotion: {
                  at: '2026-10-16T00:00:00Z',
                  by: 'ops',
                  from: '10.250.0.3',
                  to: '9.9.9.9',
                },
              },
            },
          ]),
        save: jest.fn(),
      } as never,
      {
        find: jest.fn().mockResolvedValue([
          { id: 'm', serverName: 'ctl-master' },
          { id: 'w1', serverName: 'ctl-worker-1' },
          { id: 'x1', serverName: 'demo-master' },
        ]),
      } as never,
      {
        controlPeers: jest.fn().mockResolvedValue([primary, worker]),
        livePeers: jest.fn().mockResolvedValue([primary, worker, member]),
      } as never,
      { publicAddressOf: () => '5.6.7.8' } as never,
    );
  };

  it('lists one end per control node, the primary first, with what each reaches', async () => {
    const status = await build().status();
    expect(status.hubs).toEqual([
      expect.objectContaining({
        nodeName: 'ctl-master',
        primary: true,
        address: '10.250.0.1',
        endpoint: '5.6.7.8:51821',
        status: 'active',
        membersReached: 1,
        membersNotReached: 0,
      }),
      expect.objectContaining({
        nodeName: 'ctl-worker-1',
        primary: false,
        address: '10.250.0.2',
        endpoint: '6.6.6.6:51821',
        status: 'stale',
        membersReached: 0,
        membersNotReached: 1,
      }),
    ]);
    expect(status.hub).toEqual({
      address: '10.250.0.1',
      endpoint: '5.6.7.8:51821',
      keyed: true,
    });
  });

  it('never lists a control node among the members, and says which control node misses a member', async () => {
    const { members } = await build('active').status();
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      clusterName: 'demo',
      unreachedFrom: ['ctl-worker-1'],
      heldOffOverlay: true,
    });
  });

  it('does not name a control node whose end is not up as one the member waits on', async () => {
    for (const status of ['stale', 'pending']) {
      const { members } = await build(status).status();
      expect(members[0].unreachedFrom).toEqual([]);
    }
  });

  it('passes on a warning about how the control end is set up', async () => {
    controlEndWarned(
      'FLUI_WG_ENDPOINT_NAME wg.example.org resolves to 6.6.6.6',
    );
    expect((await build().status()).hubWarning).toContain('wg.example.org');
    controlEndWarned(null);
    expect((await build().status()).hubWarning).toBeNull();
  });
});
