jest.mock('@flui-cloud/infra', () => ({
  OvhProviderService: jest.fn(),
  packRegionId: jest.fn(),
  parseRegionId: jest.fn(),
}));
jest.mock('./ovh-openstack-client.factory', () => ({
  buildOvhOpenStackClient: jest.fn().mockResolvedValue({}),
}));

import {
  OvhProviderService as InfraOvhProviderService,
  parseRegionId,
} from '@flui-cloud/infra';
import { buildOvhOpenStackClient } from './ovh-openstack-client.factory';
import {
  OvhProviderService,
  normalizeOvhServerStatus,
} from './ovh-provider.service';

describe('normalizeOvhServerStatus', () => {
  it('maps Nova ACTIVE to the common "running" ServersService.waitForServerReady polls for', () => {
    expect(normalizeOvhServerStatus('ACTIVE')).toBe('running');
  });

  it('maps Nova ERROR to the common "error"', () => {
    expect(normalizeOvhServerStatus('ERROR')).toBe('error');
  });

  it('lowercases any other Nova status rather than leaving it opaque uppercase', () => {
    expect(normalizeOvhServerStatus('BUILD')).toBe('build');
    expect(normalizeOvhServerStatus('SHUTOFF')).toBe('shutoff');
  });
});

describe('OvhProviderService.getServerStatus — not-found translation', () => {
  function build(getServerStatus: jest.Mock) {
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({ getServerStatus }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    return new OvhProviderService({} as never, credentialProvider as never);
  }

  it('translates infra\'s "not found" throw into the "not-found" status string waitForDeletionComplete polls for', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new Error('OVH server abc-123 not found.')),
    );

    await expect(service.getServerStatus('abc-123')).resolves.toBe('not-found');
  });

  it('re-throws any error that is not a "not found" — a transient failure must not look like a completed delete', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new Error('OVH API unreachable')),
    );

    await expect(service.getServerStatus('abc-123')).rejects.toThrow(
      'OVH API unreachable',
    );
  });

  it('normalizes a real status when the call succeeds', async () => {
    const service = build(jest.fn().mockResolvedValue('ACTIVE'));

    await expect(service.getServerStatus('abc-123')).resolves.toBe('running');
  });
});

describe('OvhProviderService.createServer — post-boot network attach', () => {
  it('reboots only when the console confirms the guest actually hit the NIC race', async () => {
    jest.useFakeTimers();
    try {
      const attachServerInterface = jest.fn().mockResolvedValue(undefined);
      const rebootServer = jest.fn().mockResolvedValue(undefined);
      const resolveComputeRegion = jest.fn().mockResolvedValue('GRA11');
      const getConsoleOutput = jest
        .fn()
        .mockResolvedValue(
          "cloud-init[593]: Traceback...\nValueError: Unable to find a system nic for {'mac': 'x'}",
        );
      (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
        resolveComputeRegion,
        attachServerInterface,
        rebootServer,
        getConsoleOutput,
      });
      (parseRegionId as jest.Mock).mockReturnValue({ id: 'net-1' });
      (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
        () => ({
          createServer: jest.fn().mockResolvedValue({
            serverId: 'srv-1',
            ipAddress: '1.2.3.4',
            status: 'ACTIVE',
          }),
          getServerDetailsAsDto: jest.fn().mockResolvedValue({
            status: 'ACTIVE',
            public_ip: '1.2.3.4',
            private_ip: '10.0.0.5',
          }),
        }),
      );
      const credentialProvider = {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      };
      const service = new OvhProviderService(
        {} as never,
        credentialProvider as never,
      );

      const resultPromise = service.createServer({
        name: 'workload-2-master',
        networks: ['region:net-1'],
      } as never);
      // pollForNicRaceOutcome's first console check fires after one
      // pollIntervalMs (5s); the crash signature is there from that first
      // check, so it resolves immediately — then the existing 5s
      // post-reboot settle delay runs before waitForServerActive.
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(attachServerInterface).toHaveBeenCalledWith(
        'GRA11',
        'srv-1',
        'net-1',
      );
      expect(getConsoleOutput).toHaveBeenCalledWith('GRA11', 'srv-1', 500);
      expect(rebootServer).toHaveBeenCalledWith('GRA11', 'srv-1');
      expect(rebootServer.mock.invocationCallOrder[0]).toBeGreaterThan(
        attachServerInterface.mock.invocationCallOrder[0],
      );
      expect(result.privateIp).toBe('10.0.0.5');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT reboot when the console shows cloud-init finished cleanly — a guest bootstrap script may already be running', async () => {
    jest.useFakeTimers();
    try {
      const attachServerInterface = jest.fn().mockResolvedValue(undefined);
      const rebootServer = jest.fn().mockResolvedValue(undefined);
      const getConsoleOutput = jest
        .fn()
        .mockResolvedValue(
          'Cloud-init v. 26.1 finished at Sat, 12 Sep 2026 21:25:50 +0000. Datasource DataSourceOpenStackLocal [net,ver=2].',
        );
      (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
        resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
        attachServerInterface,
        rebootServer,
        getConsoleOutput,
      });
      (parseRegionId as jest.Mock).mockReturnValue({ id: 'net-1' });
      (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
        () => ({
          createServer: jest.fn().mockResolvedValue({
            serverId: 'srv-1',
            ipAddress: '1.2.3.4',
            status: 'ACTIVE',
          }),
        }),
      );
      const credentialProvider = {
        getActiveAccessKeyPair: jest
          .fn()
          .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
      };
      const service = new OvhProviderService(
        {} as never,
        credentialProvider as never,
      );

      const resultPromise = service.createServer({
        name: 'workload-2-master',
        networks: ['region:net-1'],
      } as never);
      await jest.advanceTimersByTimeAsync(5_000);
      await resultPromise;

      expect(getConsoleOutput).toHaveBeenCalled();
      expect(rebootServer).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never reboots a server with no networks to attach (e.g. the control cluster)', async () => {
    const attachServerInterface = jest.fn();
    const rebootServer = jest.fn();
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      resolveComputeRegion: jest.fn().mockResolvedValue('GRA11'),
      attachServerInterface,
      rebootServer,
    });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createServer: jest.fn().mockResolvedValue({
          serverId: 'srv-1',
          ipAddress: '1.2.3.4',
          status: 'ACTIVE',
        }),
      }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    const service = new OvhProviderService(
      {} as never,
      credentialProvider as never,
    );

    await service.createServer({ name: 'control-master' } as never);

    expect(attachServerInterface).not.toHaveBeenCalled();
    expect(rebootServer).not.toHaveBeenCalled();
  });
});

describe('OvhProviderService.listInstances', () => {
  function build(servers: unknown[], nodeSizes: unknown[] = []) {
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({});
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        listServersAsDto: jest.fn().mockResolvedValue(servers),
        getNodeSizes: jest.fn().mockResolvedValue(nodeSizes),
      }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    return new OvhProviderService({} as never, credentialProvider as never);
  }

  it('is no longer the hard-coded empty stub — real servers come back as InstanceEntity', async () => {
    const service = build(
      [
        {
          id: 'srv-1',
          name: 'control-cluster-local-dev-master',
          server_type: 'd2-4',
          location: 'GRA11',
          status: 'ACTIVE',
          public_ip: '91.134.239.43',
          private_ip: '10.10.1.69',
          labels: [
            { key: 'managed-by', value: 'flui-cloud' },
            { key: 'flui-cluster-id', value: 'cluster-1' },
          ],
        },
      ],
      [{ id: 'd2-4', name: 'd2-4', cores: 2, memory: 4, disk: 50 }],
    );

    const instances = await service.listInstances();

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      name: 'control-cluster-local-dev-master',
      providerId: 'srv-1',
      status: 'running',
      cpuCores: 2,
      ramMb: 4096,
      diskMb: 51200,
      ipConfig: { v4: { ip: '91.134.239.43', gateway: '', netmaskCidr: 32 } },
    });
    // classifyOwnership() in InstancesService reads metadata.labels as a
    // plain Record, not ServerResponseDto's {key,value}[] shape.
    expect(instances[0].metadata.labels).toEqual({
      'managed-by': 'flui-cloud',
      'flui-cluster-id': 'cluster-1',
    });
  });

  it('scopes to one cluster via the flui-cluster-id label when clusterId is passed', async () => {
    const service = build([
      {
        id: 'srv-1',
        name: 'a',
        server_type: 'd2-4',
        status: 'ACTIVE',
        labels: [{ key: 'flui-cluster-id', value: 'cluster-1' }],
      },
      {
        id: 'srv-2',
        name: 'b',
        server_type: 'd2-4',
        status: 'ACTIVE',
        labels: [{ key: 'flui-cluster-id', value: 'cluster-2' }],
      },
    ]);

    const instances = await service.listInstances({ clusterId: 'cluster-2' });

    expect(instances.map((i) => i.name)).toEqual(['b']);
  });
});

describe('OvhProviderService.createVNet — subnet gateway clear targets the resolved region', () => {
  it("resolves the caller's region macro (e.g. 'GRA') through resolveNetworkRegion instead of handing it to clearSubnetGateway raw", async () => {
    const setDefaultRegion = jest.fn();
    const resolveNetworkRegion = jest.fn().mockResolvedValue('GRA11');
    const clearSubnetGateway = jest.fn().mockResolvedValue(undefined);
    (buildOvhOpenStackClient as jest.Mock).mockResolvedValue({
      setDefaultRegion,
      resolveNetworkRegion,
      clearSubnetGateway,
    });
    (InfraOvhProviderService as unknown as jest.Mock).mockImplementation(
      () => ({
        createVNet: jest.fn().mockResolvedValue({
          subnets: [{ id: 'subnet-1' }],
        }),
      }),
    );
    const credentialProvider = {
      getActiveAccessKeyPair: jest
        .fn()
        .mockResolvedValue({ accessKey: 'ak', secretKey: 'sk' }),
    };
    const service = new OvhProviderService(
      {} as never,
      credentialProvider as never,
    );

    await service.createVNet({
      subnets: [{ networkZone: 'GRA' }],
    } as never);

    expect(resolveNetworkRegion).toHaveBeenCalledWith('GRA');
    expect(clearSubnetGateway).toHaveBeenCalledWith('GRA11', 'subnet-1');
  });
});
