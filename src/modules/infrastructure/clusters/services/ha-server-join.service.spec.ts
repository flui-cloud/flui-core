// Pulled in transitively and ship ESM that jest won't parse; unused on these paths.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { HaServerJoinService, haJoinOutcome } from './ha-server-join.service';

describe('HaServerJoinService', () => {
  const CLUSTER = {
    id: 'c-1',
    name: 'ha-hz',
    clusterType: 'workload',
    masterPrivateIp: '10.0.1.2',
    masterIpAddress: '203.0.113.2',
    masterNodeId: 'n-master',
    k3sTokenEncrypted: 'enc',
  };

  function build({
    orchestration = {},
    nodeRepository = {},
    execCommand = jest.fn(),
  }: {
    orchestration?: Record<string, unknown>;
    nodeRepository?: Record<string, unknown>;
    execCommand?: jest.Mock;
  } = {}) {
    const service = new HaServerJoinService(
      {
        prepareBootstrapKey: jest.fn(),
        bootstrapPrivateKey: jest.fn().mockResolvedValue('priv'),
        nodeSshHost: (_c: unknown, n: { serverName: string }) => n.serverName,
        ...orchestration,
      } as never,
      nodeRepository as never,
      { decrypt: () => 'K10token::server:x' } as never,
      { execCommand } as never,
    );
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    return service;
  }

  describe('buyServersToJoinLater', () => {
    it('buys every server at once, each in its location with its size', async () => {
      const buyWorkerToJoinLater = jest.fn(async (...args: unknown[]) => ({
        serverName: `ha-hz-worker-${String(args[1])}`,
      }));
      const service = build({
        orchestration: {
          nextWorkerIndex: jest.fn().mockResolvedValue(1),
          buyWorkerToJoinLater,
        },
        nodeRepository: { find: jest.fn().mockResolvedValue([]) },
      });

      const result = await service.buyServersToJoinLater(
        CLUSTER as never,
        [
          { zone: 'nbg1', shape: 'cpx22' },
          { zone: 'hel1', shape: 'cx23' },
        ],
        'op-1',
        ['fw-1'],
      );

      expect(buyWorkerToJoinLater.mock.calls.map((c) => [c[1], c[2]])).toEqual([
        [1, { zone: 'nbg1', shape: 'cpx22' }],
        [2, { zone: 'hel1', shape: 'cx23' }],
      ]);
      expect(result.map((r) => r.zone)).toEqual(['nbg1', 'hel1']);
    });

    it('reuses the machine a retried creation already bought for a location', async () => {
      const buyWorkerToJoinLater = jest.fn().mockResolvedValue({});
      const service = build({
        orchestration: {
          nextWorkerIndex: jest.fn().mockResolvedValue(2),
          buyWorkerToJoinLater,
        },
        nodeRepository: {
          find: jest
            .fn()
            .mockResolvedValue([
              { region: 'nbg1', metadata: { joinLater: true, workerIndex: 1 } },
            ]),
        },
      });

      await service.buyServersToJoinLater(
        CLUSTER as never,
        [
          { zone: 'nbg1', shape: 'cpx22' },
          { zone: 'hel1', shape: 'cpx22' },
        ],
        'op-1',
        [],
      );

      expect(buyWorkerToJoinLater.mock.calls.map((c) => c[1])).toEqual([1, 2]);
    });

    it('reports a location the provider would not sell, without stopping the others', async () => {
      const service = build({
        orchestration: {
          nextWorkerIndex: jest.fn().mockResolvedValue(1),
          buyWorkerToJoinLater: jest
            .fn()
            .mockResolvedValueOnce({ serverName: 'w-1' })
            .mockRejectedValueOnce(new Error('resource_unavailable')),
        },
        nodeRepository: { find: jest.fn().mockResolvedValue([]) },
      });

      const result = await service.buyServersToJoinLater(
        CLUSTER as never,
        [
          { zone: 'nbg1', shape: 'cpx22' },
          { zone: 'hel1', shape: 'cpx22' },
        ],
        'op-1',
        [],
      );

      expect(result).toEqual([
        { zone: 'nbg1', node: { serverName: 'w-1' } },
        { zone: 'hel1', error: 'resource_unavailable' },
      ]);
    });
  });

  describe('joinWaitingServers', () => {
    const waiting = [
      {
        serverName: 'ha-hz-worker-2',
        region: 'hel1',
        status: 'joining',
        providerResourceId: 'p2',
        metadata: { joinLater: true, workerIndex: 2 },
      },
      {
        serverName: 'ha-hz-worker-1',
        region: 'nbg1',
        status: 'joining',
        providerResourceId: 'p1',
        metadata: { joinLater: true, workerIndex: 1 },
      },
      {
        serverName: 'ha-hz-worker-9',
        region: 'fsn1',
        status: 'joining',
        providerResourceId: 'p9',
        metadata: { workerIndex: 9 },
      },
    ];

    it('hands each server where to join only after the one before it joined, in the planned order', async () => {
      const order: string[] = [];
      const execCommand = jest.fn(async (...args: string[]) => {
        order.push(`hand ${args[0]}`);
        return 'join-details-handed-over';
      });
      const awaitServerJoin = jest.fn(async (...args: unknown[]) => {
        const node = args[1] as { serverName: string };
        order.push(`joined ${node.serverName}`);
        return node;
      });
      const service = build({
        orchestration: { awaitServerJoin },
        nodeRepository: { find: jest.fn().mockResolvedValue(waiting) },
        execCommand,
      });

      const { joined, failed } = await service.joinWaitingServers(
        CLUSTER as never,
        'op-1',
      );

      expect(order).toEqual([
        'hand ha-hz-worker-1',
        'joined ha-hz-worker-1',
        'hand ha-hz-worker-2',
        'joined ha-hz-worker-2',
      ]);
      expect(joined).toHaveLength(2);
      expect(failed).toEqual([]);
      const script = execCommand.mock.calls[0][3] as string;
      expect(script).toContain("K3S_URL='https://10.0.1.2:6443'");
      expect(script).toContain("FLUI_SHARED_STORAGE_MASTER_IP='10.0.1.2'");
    });

    it('goes on to the next server when one does not join', async () => {
      const service = build({
        orchestration: {
          awaitServerJoin: jest
            .fn()
            .mockRejectedValueOnce(new Error('did not become Ready'))
            .mockImplementation(async (_c, node) => node),
        },
        nodeRepository: { find: jest.fn().mockResolvedValue(waiting) },
        execCommand: jest.fn().mockResolvedValue('join-details-handed-over'),
      });

      const { joined, failed } = await service.joinWaitingServers(
        CLUSTER as never,
        'op-1',
      );

      expect(failed).toEqual([
        {
          name: 'ha-hz-worker-1',
          zone: 'nbg1',
          error: 'did not become Ready',
        },
      ]);
      expect(joined.map((n) => n.serverName)).toEqual(['ha-hz-worker-2']);
    });

    it('keeps trying to reach a server that is still booting', async () => {
      const execCommand = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue('join-details-handed-over');
      const service = build({
        orchestration: { awaitServerJoin: jest.fn(async (_c, node) => node) },
        nodeRepository: { find: jest.fn().mockResolvedValue([waiting[1]]) },
        execCommand,
      });

      const { joined } = await service.joinWaitingServers(
        CLUSTER as never,
        'op-1',
      );

      expect(execCommand).toHaveBeenCalledTimes(2);
      expect(joined).toHaveLength(1);
    });
  });

  describe('waitForPlatformInstalled', () => {
    const master = {
      findOne: jest.fn().mockResolvedValue({ serverName: 'master' }),
    };

    it('waits until the first server marks the install finished', async () => {
      const execCommand = jest
        .fn()
        .mockResolvedValueOnce('platform-installing')
        .mockResolvedValueOnce('platform-installed');
      const service = build({ nodeRepository: master, execCommand });

      await expect(
        service.waitForPlatformInstalled(CLUSTER as never, 60_000),
      ).resolves.toBe('installed');
      expect(execCommand).toHaveBeenCalledTimes(2);
    });

    it('stops waiting as soon as the boot script has ended without finishing', async () => {
      const execCommand = jest
        .fn()
        .mockResolvedValueOnce('platform-installing')
        .mockResolvedValueOnce('platform-stopped');
      const service = build({ nodeRepository: master, execCommand });

      await expect(
        service.waitForPlatformInstalled(CLUSTER as never, 60_000),
      ).resolves.toBe('stopped');
      expect(execCommand.mock.calls[0][3]).toContain('cloud-init status');
    });

    it('says so when it has not finished in time', async () => {
      const service = build({
        nodeRepository: master,
        execCommand: jest.fn().mockResolvedValue('platform-installing'),
      });

      await expect(
        service.waitForPlatformInstalled(CLUSTER as never, 0),
      ).resolves.toBe('timeout');
    });
  });

  describe('haJoinOutcome', () => {
    const plan = {
      region: 'eu-central',
      first: { zone: 'fsn1', shape: 'cpx22' },
      servers: [],
      later: [],
    };

    it('names every location when every server joined', () => {
      expect(haJoinOutcome(plan, ['nbg1', 'hel1'], [])).toEqual({
        joinedMessage: 'Joined the servers in nbg1 and hel1',
        readyMessage: 'Cluster ready across fsn1, nbg1, hel1',
      });
    });

    it('names the location still missing a server', () => {
      expect(haJoinOutcome(plan, ['nbg1'], ['hel1']).readyMessage).toBe(
        'Cluster ready in fsn1, nbg1; a server is still missing in hel1: add it from the High availability tab',
      );
    });
  });
});
