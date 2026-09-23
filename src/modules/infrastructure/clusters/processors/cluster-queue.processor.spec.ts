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
  function build(runImpl: jest.Mock) {
    const node = {
      id: 'node-w1',
      serverName: 'workload-1-worker-1',
      providerResourceId: null,
    };
    const cluster = {
      id: 'cluster-1',
      name: 'workload-1',
      provider: 'hetzner',
      clusterType: ClusterType.WORKLOAD,
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
    });

    const run = () =>
      processor.handleRemoveWorker({
        id: 'job-1',
        data: {
          operationId: operation.id,
          clusterId: cluster.id,
          nodeId: node.id,
        },
      } as never);

    return { run, operation, nodeRepository };
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

    const commands = run.mock.calls.map((c) => c[1] as string);
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
  });
});
