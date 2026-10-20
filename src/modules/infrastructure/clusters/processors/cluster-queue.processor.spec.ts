jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterQueueProcessor } from './cluster-queue.processor';
import { ClusterStatus, ClusterType } from '../entities/cluster.entity';
import {
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { HostnameMode } from '../../../dns/enums/hostname-mode.enum';
import { getOperationSteps } from '../../operations/helpers/operation-steps.helper';
import { DrainFeasibilityService } from '../../scaling/engine/drain-feasibility.service';

/**
 * The writer (ClusterCreationService) only ever nests the request DTO under
 * metadata.clusterConfig; it never populates a top-level metadata.workerCount.
 * These fixtures deliberately omit that top-level field to reproduce the exact
 * shape that used to make handleCreateCluster silently treat every cluster as
 * single-node.
 */
describe('ClusterQueueProcessor.handleCreateCluster', () => {
  function buildCluster() {
    return {
      id: 'cluster-1',
      name: 'workload-1',
      provider: 'hetzner',
      status: ClusterStatus.CREATING,
      clusterType: ClusterType.WORKLOAD,
      endpointHostnameMode: HostnameMode.DOMAIN,
      metadata: {},
      nodeCount: 0,
    };
  }

  function buildOperation(workerCount: number) {
    return {
      id: 'op-1',
      status: OperationStatus.PENDING,
      metadata: {
        clusterConfig: {
          name: 'workload-1',
          provider: 'hetzner',
          region: 'fsn1',
          nodeSize: 'cx22',
          workerCount,
        },
        operationSteps: getOperationSteps(OperationType.CREATE_CLUSTER, {
          workerCount,
        }),
        providerFirewallId: null,
      } as Record<string, any>,
    };
  }

  function build(workerCount: number) {
    const cluster = buildCluster();
    const operation = buildOperation(workerCount);

    const clusterRepository = {
      findOne: jest.fn().mockResolvedValue(cluster),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const operationRepository = {
      findOne: jest.fn().mockResolvedValue(operation),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const orchestrationService = {
      createMasterNode: jest
        .fn()
        .mockResolvedValue({ id: 'node-master', ipAddress: '1.2.3.4' }),
      createWorkerNodes: jest.fn().mockResolvedValue([]),
    };
    const capabilitiesFactory = {
      getCapabilitiesService: jest.fn().mockReturnValue({
        getStaticCapabilities: jest
          .fn()
          .mockReturnValue({ firewall: { backend: 'managed-api' } }),
      }),
    };
    const clusterDnsZoneService = {
      getZonesForCluster: jest.fn().mockResolvedValue([]),
      reconcileAssignment: jest.fn(),
      bootstrapHttpIssuersForCluster: jest.fn(),
    };
    const grafanaConfigService = {
      getControlCluster: jest.fn().mockResolvedValue(null),
    };
    const grafanaDatasourceService = {
      addClusterDatasources: jest.fn(),
    };
    const infraGateway = {
      emitProgress: jest.fn(),
      emitCompleted: jest.fn(),
      emitFailed: jest.fn(),
    };
    const vnetsService = { ensureClusterIdLabel: jest.fn() };
    const clusterFirewallIntegrationService = {
      syncHostLayer: jest.fn().mockResolvedValue(undefined),
    };

    const processor = Object.create(
      ClusterQueueProcessor.prototype,
    ) as ClusterQueueProcessor;
    Object.assign(processor, {
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
      clusterRepository,
      operationRepository,
      orchestrationService,
      capabilitiesFactory,
      clusterDnsZoneService,
      grafanaConfigService,
      grafanaDatasourceService,
      infraGateway,
      vnetsService,
      clusterFirewallIntegrationService,
    });

    const run = () =>
      processor.handleCreateCluster({
        id: 'job-1',
        data: { operationId: operation.id, clusterId: cluster.id },
      } as never);

    return {
      run,
      cluster,
      operation,
      orchestrationService,
      infraGateway,
      clusterFirewallIntegrationService,
    };
  }

  it('creates the requested worker nodes for a multi-node config and does not take the single-node path', async () => {
    const { run, cluster, operation, orchestrationService, infraGateway } =
      build(2);

    await run();

    expect(orchestrationService.createWorkerNodes).toHaveBeenCalledWith(
      expect.objectContaining({ id: cluster.id }),
      2,
      operation.id,
      [],
    );

    expect(cluster.nodeCount).toBe(3);
    expect(cluster.status).toBe(ClusterStatus.READY);
    expect(infraGateway.emitProgress.mock.calls[0][2].totalSteps).toBe(5);

    expect(operation.status).toBe(OperationStatus.COMPLETED);
    expect(operation.metadata.message).toBe('Multi-node cluster ready');
    expect(operation.metadata.workerCount).toBe(2);

    expect(infraGateway.emitCompleted).toHaveBeenCalledTimes(1);
    expect(infraGateway.emitFailed).not.toHaveBeenCalled();
  });

  it('puts the host firewall on the master, then again once the workers exist', async () => {
    const { run, clusterFirewallIntegrationService, cluster } = build(2);
    await run();
    expect(clusterFirewallIntegrationService.syncHostLayer.mock.calls).toEqual([
      [cluster.id],
      [cluster.id],
    ]);
  });

  it('takes the single-node path and never calls createWorkerNodes when workerCount is 0', async () => {
    const { run, cluster, operation, orchestrationService, infraGateway } =
      build(0);

    await run();

    expect(orchestrationService.createWorkerNodes).not.toHaveBeenCalled();

    expect(cluster.nodeCount).toBe(1);
    expect(cluster.status).toBe(ClusterStatus.READY);
    expect(infraGateway.emitProgress.mock.calls[0][2].totalSteps).toBe(4);

    expect(operation.status).toBe(OperationStatus.COMPLETED);
    expect(operation.metadata.message).toBe('Single-node cluster ready');

    expect(infraGateway.emitCompleted).toHaveBeenCalledTimes(1);
    expect(infraGateway.emitFailed).not.toHaveBeenCalled();
  });
});

describe('ClusterQueueProcessor.handleRemoveWorker', () => {
  function build(runImpl: jest.Mock, extra: Record<string, any> = {}) {
    const node = {
      id: 'node-w1',
      serverName: 'workload-1-worker-1',
      providerResourceId: null,
    };
    const cluster = {
      id: 'cluster-1',
      name: 'workload-1',
      provider: 'hetzner',
      clusterType: extra.clusterType ?? ClusterType.WORKLOAD,
      masterIpAddress: '49.13.132.151',
      nodeCount: 2,
      nodes: [{ id: 'node-master' }, node],
      metadata: {},
    };
    const operation = {
      id: 'op-1',
      status: OperationStatus.PENDING,
      metadata: {
        operationSteps: getOperationSteps(OperationType.REMOVE_WORKER),
      } as Record<string, any>,
    };

    const nodeRepository = {
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const processor = Object.create(
      ClusterQueueProcessor.prototype,
    ) as ClusterQueueProcessor;
    const nodeEvents = { record: jest.fn().mockResolvedValue(null) };
    Object.assign(processor, {
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
      clusterRepository: {
        findOne: jest.fn().mockResolvedValue(cluster),
        update: jest.fn().mockResolvedValue(undefined),
      },
      nodeRepository,
      operationRepository: {
        findOne: jest.fn().mockResolvedValue(operation),
        save: jest.fn().mockResolvedValue(undefined),
      },
      billingIntervals: { closeNodeIntervals: jest.fn() },
      infraGateway: {
        emitProgress: jest.fn(),
        emitCompleted: jest.fn(),
        emitFailed: jest.fn(),
      },
      hostCommand: { run: runImpl },
      nodeEvents,
      moduleRef: extra.moduleRef ?? {
        get: (token: unknown) =>
          token === DrainFeasibilityService ? (extra.drain ?? fine()) : null,
      },
    });

    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const run = () =>
      processor.handleRemoveWorker({
        id: 'job-1',
        name: 'remove-worker',
        opts: {},
        queue,
        data: {
          operationId: operation.id,
          clusterId: cluster.id,
          nodeId: node.id,
          heldRetries: extra.heldRetries,
        },
      } as never);

    return { run, operation, nodeRepository, nodeEvents, node, queue };
  }

  /** A node whose work can go elsewhere, with what would move. */
  function fine(moves: unknown[] = []) {
    return {
      check: jest.fn().mockResolvedValue({
        ok: true,
        blockers: [],
        cleared: [],
        moves,
      }),
      roomElsewhere: jest.fn().mockResolvedValue({
        fits: true,
        needs: { cpuMillicores: 0, memoryMi: 0 },
        room: { cpuMillicores: 0, memoryMi: 0 },
        stranded: [],
      }),
    };
  }

  /** The readiness probe answers `ready`; every other command succeeds. */
  function readyIs(ready: string) {
    return jest
      .fn()
      .mockImplementation((_target, command: string) =>
        Promise.resolve(command.includes('kubectl get node') ? ready : ''),
      );
  }

  /** Answers the drain with a failure and the readiness probe with `ready`. */
  function drainFailsWith(ready: string | Error) {
    return jest.fn().mockImplementation((_target, command: string) => {
      if (command.includes('kubectl drain')) {
        return Promise.reject(new Error('eviction blocked by a budget'));
      }
      if (command.includes('kubectl get node')) {
        return ready instanceof Error
          ? Promise.reject(ready)
          : Promise.resolve(ready);
      }
      return Promise.resolve('');
    });
  }

  it('reaches the master through the certificate path, never a stored key', async () => {
    const run = jest.fn().mockResolvedValue('');
    const t = build(run);

    await t.run();

    const commands = run.mock.calls
      .map((c) => c[1] as string)
      .filter((c) => !c.includes('kubectl get node'));
    expect(commands[0]).toContain('kubectl cordon');
    expect(commands[1]).toContain('kubectl drain');
    expect(commands[2]).toContain('kubectl delete node');
    for (const call of run.mock.calls) {
      expect(call[0]).toEqual({
        host: '49.13.132.151',
        port: 22,
        user: 'root',
      });
    }
    expect(t.operation.metadata.warnings).toEqual([]);
  });

  it('marks a control worker as going before the Flui network withdraws it, so no sweep brings it back', async () => {
    const seen: string[] = [];
    const membership = {
      beforeControlNodeRemoved: jest.fn(async () => {
        seen.push(t.node['status']);
        return [];
      }),
    };
    const drain = fine();
    const t = build(jest.fn().mockResolvedValue(''), {
      clusterType: ClusterType.CONTROL,
      moduleRef: {
        get: (token: unknown) =>
          token === DrainFeasibilityService ? drain : membership,
      },
    });

    await t.run();

    expect(membership.beforeControlNodeRemoved).toHaveBeenCalledWith('node-w1');
    expect(seen).toEqual(['deleting']);
    expect(t.nodeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'node-w1', status: 'deleting' }),
    );
  });

  it('writes that the node was emptied and then deleted at the provider', async () => {
    const t = build(jest.fn().mockResolvedValue(''));

    await t.run();

    expect(t.nodeEvents.record.mock.calls.map((c) => c[0].event)).toEqual([
      'node-drained',
      'node-removed',
    ]);
    expect(t.nodeEvents.record.mock.calls[1][0]).toMatchObject({
      clusterId: 'cluster-1',
      node: 'workload-1-worker-1',
      by: null,
    });
  });

  it('refuses to destroy a node that is still ready and would not drain', async () => {
    const t = build(drainFailsWith("'True'"));

    await expect(t.run()).rejects.toThrow(/Refusing to destroy/);

    expect(t.nodeRepository.delete).not.toHaveBeenCalled();
    expect(t.operation.status).toBe(OperationStatus.FAILED);
  });

  it('refuses when the drain failed and the node state cannot be read', async () => {
    const t = build(drainFailsWith(new Error('host unreachable')));

    await expect(t.run()).rejects.toThrow(/Refusing to destroy/);

    expect(t.nodeRepository.delete).not.toHaveBeenCalled();
  });

  it('removes a node the control plane has already lost, which no drain could empty', async () => {
    const t = build(drainFailsWith("'Unknown'"));

    await t.run();

    expect(t.nodeRepository.delete).toHaveBeenCalledWith({ id: 'node-w1' });
    expect(
      (t.operation.metadata.warnings as Array<{ code: string }>).map(
        (w) => w.code,
      ),
    ).toContain('DRAIN_FAILED');
    expect(t.nodeEvents.record.mock.calls[0][0].warning).toContain(
      'could not be emptied cleanly',
    );
  });

  it('touches nothing when what runs on the node has nowhere to go, and says so', async () => {
    const run = readyIs("'True'");
    const drain = fine();
    drain.check.mockResolvedValue({
      ok: false,
      blockers: [
        {
          kind: 'runs-flui-api',
          what: 'flui-system/flui-api-5f597b7d65-gcrhj',
          fix: 'The Flui API runs on this machine and is what carries out the removal. Nothing is changed.',
        },
      ],
      cleared: [],
      moves: [],
    });
    const t = build(run, { drain });

    await expect(t.run()).rejects.toThrow(/^Nothing was changed/);

    const commands = run.mock.calls.map((c) => c[1] as string);
    expect(commands.some((c) => c.includes('kubectl cordon'))).toBe(false);
    expect(commands.some((c) => c.includes('kubectl drain'))).toBe(false);
    expect(t.nodeRepository.save).not.toHaveBeenCalled();
    expect(t.operation.status).toBe(OperationStatus.FAILED);
  });

  it('holds on silence: a cluster that cannot be asked is not a yes', async () => {
    const drain = fine();
    drain.check.mockResolvedValue(null);
    const t = build(readyIs("'True'"), { drain });

    await expect(t.run()).rejects.toThrow(/could not be asked/);
    expect(t.nodeRepository.delete).not.toHaveBeenCalled();
  });

  it('holds when the work on the node would not fit on the machines that stay', async () => {
    const drain = fine();
    drain.roomElsewhere.mockResolvedValue({
      fits: false,
      needs: { cpuMillicores: 500, memoryMi: 512 },
      room: { cpuMillicores: 0, memoryMi: 0 },
      stranded: ['flui-api'],
    });
    const run = readyIs("'True'");
    const t = build(run, { drain });

    await expect(t.run()).rejects.toThrow(/^Nothing was changed/);
    expect(
      run.mock.calls.some((c) => String(c[1]).includes('kubectl cordon')),
    ).toBe(false);
  });

  it('lists what it started again elsewhere, the platform first', async () => {
    const drain = fine([
      { what: 'storefront', system: false },
      { what: 'flui-web', system: true },
    ]);
    const t = build(readyIs("'True'"), { drain });

    await t.run();

    const moved = (
      t.operation.metadata.warnings as Array<{ code: string; reason: string }>
    ).find((w) => w.code === 'APPS_MOVED');
    expect(moved?.reason).toBe(
      'Started again on another machine: flui-web (Flui), storefront.',
    );
  });

  describe('on a copy of the API that runs on the node itself', () => {
    const before = process.env.NODE_NAME;
    beforeEach(() => {
      process.env.NODE_NAME = 'workload-1-worker-1';
    });
    afterEach(() => {
      if (before === undefined) delete process.env.NODE_NAME;
      else process.env.NODE_NAME = before;
    });

    it('hands the removal to another copy and touches nothing', async () => {
      const run = jest.fn().mockResolvedValue('');
      const t = build(run);

      await t.run();

      expect(run).not.toHaveBeenCalled();
      expect(t.queue.add).toHaveBeenCalledWith(
        'remove-worker',
        expect.objectContaining({ heldRetries: 1 }),
        expect.objectContaining({ delay: 60_000 }),
      );
      expect(t.operation.status).toBe(OperationStatus.PENDING);
    });

    it('stops, having changed nothing, when no other copy ever takes it', async () => {
      const run = jest.fn().mockResolvedValue('');
      const t = build(run, { heldRetries: 5 });

      await expect(t.run()).rejects.toThrow(
        /^Nothing was changed: the Flui API/,
      );

      expect(run).not.toHaveBeenCalled();
      expect(t.queue.add).not.toHaveBeenCalled();
      expect(t.operation.status).toBe(OperationStatus.FAILED);
    });
  });

  it('goes ahead on a copy that runs on another node', async () => {
    const before = process.env.NODE_NAME;
    process.env.NODE_NAME = 'workload-1-master';
    try {
      const t = build(jest.fn().mockResolvedValue(''));
      await t.run();
      expect(t.nodeRepository.delete).toHaveBeenCalledWith({ id: 'node-w1' });
    } finally {
      if (before === undefined) delete process.env.NODE_NAME;
      else process.env.NODE_NAME = before;
    }
  });

  it('opens the master of a control cluster before emptying its last worker', async () => {
    const order: string[] = [];
    const run = jest.fn().mockImplementation((_target, command: string) => {
      if (command.includes('kubectl cordon')) order.push('cordon');
      return Promise.resolve('');
    });
    const t = build(run, { clusterType: ClusterType.CONTROL });
    const opened = jest
      .spyOn(
        ClusterQueueProcessor.prototype as unknown as {
          applyMasterProtection: () => Promise<void>;
        },
        'applyMasterProtection',
      )
      .mockImplementation(async () => {
        order.push('open master');
      });

    await t.run();

    expect(order[0]).toBe('open master');
    expect(order.indexOf('cordon')).toBeGreaterThan(0);
    opened.mockRestore();
  });
});

describe('ClusterQueueProcessor.handleDeleteCluster', () => {
  function build(force: boolean, nodes: Array<Record<string, unknown>>) {
    const cluster = {
      id: 'cluster-1',
      name: 'val-hz',
      provider: 'hetzner',
      status: ClusterStatus.DELETING,
      metadata: {},
      nodes,
    };
    const clusterRepository = {
      findOne: jest.fn(async () => ({ ...cluster, nodes: [...nodes] })),
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const nodeRepository = {
      remove: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const billingIntervals = {
      closeNodeIntervals: jest.fn().mockResolvedValue(undefined),
      closeVolumeIntervals: jest.fn().mockResolvedValue(undefined),
      closeClusterIntervals: jest.fn().mockResolvedValue(undefined),
    };
    const processor = Object.create(
      ClusterQueueProcessor.prototype,
    ) as ClusterQueueProcessor;
    Object.assign(processor, {
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
      clusterRepository,
      nodeRepository,
      billingIntervals,
      updateOperationStatus: jest.fn().mockResolvedValue(undefined),
      deleteClusterNodes: jest
        .fn()
        .mockResolvedValue([
          { nodeId: 'n1', nodeName: 'master', operationId: 'op-n1' },
        ]),
      waitForAllDeletions: jest.fn().mockResolvedValue(undefined),
      verifyServersDeleted: jest.fn().mockResolvedValue(undefined),
      clusterSshCleanupService: {
        cleanupClusterSSHKeys: jest.fn().mockResolvedValue(undefined),
      },
      clusterDeletionService: {
        cleanupClusterFirewall: jest.fn().mockResolvedValue(undefined),
        cleanupClusterDnsRecords: jest.fn().mockResolvedValue(undefined),
        cleanupClusterScalingGroups: jest.fn().mockResolvedValue(undefined),
      },
      infraGateway: {
        emitProgress: jest.fn(),
        emitCompleted: jest.fn(),
        emitFailed: jest.fn(),
      },
    });
    const run = () =>
      processor.handleDeleteCluster({
        id: 'job-1',
        data: { operationId: 'op-1', clusterId: 'cluster-1', force },
      } as never);
    return { run, clusterRepository, nodeRepository, billingIntervals };
  }

  it.each([false, true])(
    'ends every billed lifetime and every node record at the deletion time (force=%s)',
    async (force) => {
      const t = build(force, [
        { id: 'n1', serverName: 'master', providerResourceId: '123' },
      ]);

      await t.run();

      const [closedCluster, closedAt] =
        t.billingIntervals.closeClusterIntervals.mock.calls[0];
      expect(closedCluster).toBe('cluster-1');
      expect(t.nodeRepository.delete).toHaveBeenCalledWith({
        clusterId: 'cluster-1',
      });
      expect(t.clusterRepository.update).toHaveBeenCalledWith('cluster-1', {
        status: ClusterStatus.DELETED,
        deletedAt: closedAt,
      });
      expect(t.clusterRepository.save).not.toHaveBeenCalled();
    },
  );

  it('still marks the cluster deleted when its node records cannot be removed', async () => {
    const t = build(false, [
      { id: 'n1', serverName: 'master', providerResourceId: '123' },
    ]);
    t.nodeRepository.delete.mockRejectedValueOnce(new Error('lock timeout'));

    await t.run();

    expect(t.billingIntervals.closeClusterIntervals).toHaveBeenCalled();
    expect(t.clusterRepository.update).toHaveBeenCalledWith(
      'cluster-1',
      expect.objectContaining({ status: ClusterStatus.DELETED }),
    );
  });
});
