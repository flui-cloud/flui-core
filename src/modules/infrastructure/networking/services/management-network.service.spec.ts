import { BadRequestException } from '@nestjs/common';
import { ClusterType } from '../../clusters/entities/cluster.entity';
import { managementNetworkOn } from '../management-network.state';
import { controlEndFailed, controlEndHealthy } from '../control-end-health';
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
      controlPeer: jest.fn().mockResolvedValue(null),
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
        controlPeer: jest.fn().mockResolvedValue(null),
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
