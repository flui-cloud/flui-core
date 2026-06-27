// ByosNodeRemovalService → byos-vnet → vnets.service → subnet-calculator →
// ip-cidr is ESM-only; stub the calculator (unused here) so the graph loads.
jest.mock('../../vnets/utils/subnet-calculator', () => ({
  SubnetCalculator: { validateSubnetInRange: () => true },
}));

import { ByosNodeRemovalService } from './byos-node-removal.service';
import { NodeType } from '../entities/cluster-node.entity';
import { OperationStatus } from '../../servers/entities/infrastructure-operations.entity';

interface ExecCall {
  host: string;
  user: string;
  command: string;
  timeout: number;
  options: { certificate?: string; port?: number };
}

describe('ByosNodeRemovalService', () => {
  function make(
    opts: {
      execImpl?: (cmd: string) => string | Promise<string>;
      firewall?: { id: string } | null;
    } = {},
  ) {
    const execCalls: ExecCall[] = [];
    const execImpl =
      opts.execImpl ??
      ((cmd: string) =>
        cmd.includes('k3s-agent-uninstall') ? 'FLUI_AGENT_UNINSTALLED\n' : '');

    const nativeSsh = {
      execCommand: jest
        .fn()
        .mockImplementation(
          async (host, user, _pk, command, timeout, options) => {
            execCalls.push({ host, user, command, timeout, options });
            return execImpl(command);
          },
        ),
    };
    const certificateSigner = {
      generateEphemeralCertificate: jest
        .fn()
        .mockResolvedValue({ privateKey: 'pk', certificate: 'cert' }),
    };
    const firewallReconciliation = {
      reconcileClusterFirewallIfExists: jest
        .fn()
        .mockResolvedValue(
          opts.firewall === undefined ? { id: 'fw-1' } : opts.firewall,
        ),
    };
    const nodeRepository = {
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
    };
    const clusterRepository = { update: jest.fn().mockResolvedValue({}) };
    const operationRepository = {
      create: jest.fn().mockImplementation((x) => x),
      save: jest
        .fn()
        .mockImplementation((x) => Promise.resolve({ ...x, id: 'op-1' })),
    };

    const byosVNet = { detachNode: jest.fn().mockResolvedValue(undefined) };

    const svc = new ByosNodeRemovalService(
      clusterRepository as any,
      nodeRepository as any,
      operationRepository as any,
      certificateSigner as any,
      nativeSsh as any,
      firewallReconciliation as any,
      byosVNet as any,
    );

    return {
      svc,
      execCalls,
      nativeSsh,
      nodeRepository,
      clusterRepository,
      operationRepository,
      firewallReconciliation,
      byosVNet,
    };
  }

  const worker = () => ({
    id: 'n-w1',
    nodeType: NodeType.WORKER,
    serverName: 'flui-byos-worker-1',
    ipAddress: '10.89.0.5',
    privateIp: '10.89.0.5',
    metadata: { byos: { host: 'localhost', port: 2223, user: 'root' } },
  });

  const cluster = (extra: Partial<any> = {}) => ({
    id: 'c-1',
    name: 'flui-byos',
    provider: 'byos',
    masterIpAddress: '10.89.0.2',
    metadata: { byos: { port: 2222, user: 'root' } },
    nodes: [
      {
        id: 'n-master',
        nodeType: NodeType.MASTER,
        serverName: 'master',
        ipAddress: '10.89.0.2',
        metadata: {},
      },
      worker(),
    ],
    ...extra,
  });

  it('cordons/drains via the master, uninstalls on the node, deletes from k3s, deregisters and reconciles the firewall', async () => {
    const {
      svc,
      execCalls,
      nodeRepository,
      clusterRepository,
      firewallReconciliation,
      byosVNet,
    } = make();

    const op = await svc.removeWorker(cluster() as any, worker() as any);

    // master ops use cluster byos port; the worker uninstall uses the node's own port
    const masterCalls = execCalls.filter((c) => c.options.port === 2222);
    const workerCalls = execCalls.filter((c) => c.options.port === 2223);
    expect(masterCalls).toHaveLength(3); // cordon, drain, delete-node
    expect(workerCalls).toHaveLength(1); // uninstall

    expect(masterCalls[0].host).toBe('10.89.0.2');
    expect(masterCalls[0].command).toContain('cordon flui-byos-worker-1');
    expect(masterCalls[1].command).toContain('drain flui-byos-worker-1');
    expect(masterCalls[2].command).toContain('delete node flui-byos-worker-1');
    expect(masterCalls[2].command).toContain(
      'flui-byos-worker-1.node-password.k3s',
    );

    expect(workerCalls[0].host).toBe('localhost');
    expect(workerCalls[0].command).toContain('k3s-agent-uninstall.sh');
    expect(workerCalls[0].command).toContain('delete table inet flui');

    expect(nodeRepository.delete).toHaveBeenCalledWith({ id: 'n-w1' });
    expect(clusterRepository.update).toHaveBeenCalledWith('c-1', {
      nodeCount: 1,
    });
    expect(
      firewallReconciliation.reconcileClusterFirewallIfExists,
    ).toHaveBeenCalledWith('c-1');
    expect(byosVNet.detachNode).toHaveBeenCalled();

    expect(op.status).toBe(OperationStatus.COMPLETED);
    expect((op.metadata as any).warnings).toEqual([]);
    expect((op.metadata as any).byos).toBe(true);
  });

  it('still deregisters when drain fails (best-effort), recording a warning', async () => {
    const { svc, nodeRepository, clusterRepository } = make({
      execImpl: (cmd) => {
        if (cmd.includes('drain ')) throw new Error('eviction blocked by PDB');
        if (cmd.includes('k3s-agent-uninstall'))
          return 'FLUI_AGENT_UNINSTALLED';
        return '';
      },
    });

    const op = await svc.removeWorker(cluster() as any, worker() as any);

    expect(nodeRepository.delete).toHaveBeenCalledWith({ id: 'n-w1' });
    expect(clusterRepository.update).toHaveBeenCalled();
    const warnings = (op.metadata as any).warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === 'DRAIN_FAILED')).toBe(true);
    expect(op.status).toBe(OperationStatus.COMPLETED);
  });

  it('records UNINSTALL_FAILED but completes when the node is unreachable', async () => {
    const { svc, nodeRepository } = make({
      execImpl: (cmd) => {
        if (cmd.includes('k3s-agent-uninstall'))
          throw new Error('connection refused');
        return '';
      },
    });

    const op = await svc.removeWorker(cluster() as any, worker() as any);

    expect(nodeRepository.delete).toHaveBeenCalled();
    const warnings = (op.metadata as any).warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === 'UNINSTALL_FAILED')).toBe(true);
  });

  it('does not warn about the firewall when none is configured', async () => {
    const { svc } = make({ firewall: null });
    const op = await svc.removeWorker(cluster() as any, worker() as any);
    const warnings = (op.metadata as any).warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === 'FIREWALL_RECONCILE_FAILED')).toBe(
      false,
    );
  });

  it('falls back to the node IP on :22 when the worker has no byos coords', async () => {
    const { svc, execCalls } = make();
    const bareWorker = {
      id: 'n-w2',
      nodeType: NodeType.WORKER,
      serverName: 'w2',
      ipAddress: '10.0.0.9',
      privateIp: '10.0.0.9',
      metadata: {},
    };
    await svc.removeWorker(cluster() as any, bareWorker as any);
    const uninstall = execCalls.find((c) =>
      c.command.includes('k3s-agent-uninstall'),
    );
    expect(uninstall?.host).toBe('10.0.0.9');
    // no node byos → inherits the cluster default port/user
    expect(uninstall?.options.port).toBe(2222);
  });
});
