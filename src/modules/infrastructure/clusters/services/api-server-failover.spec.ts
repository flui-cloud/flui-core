jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('../../networking/api-server-probe', () => ({
  apiServerAnswers: jest.fn(),
}));
jest.mock('../../networking/management-network.state', () => ({
  managementNetworkOn: () => true,
}));
jest.mock('../utils/cluster-metadata-merge.util', () => ({
  mergeClusterMetadata: jest.fn(),
}));

import { apiServerAnswers } from '../../networking/api-server-probe';
import { mergeClusterMetadata } from '../utils/cluster-metadata-merge.util';
import { ApiServerFailoverService } from './api-server-failover.service';
import { knownApiServers, readyServerCount } from './api-server-failover.core';

const answers = apiServerAnswers as jest.MockedFunction<
  typeof apiServerAnswers
>;

const kubeconfig = (host: string) =>
  `clusters:\n- cluster:\n    certificate-authority-data: Q0E=\n    server: https://${host}:6443\n`;

const k8sNode = (name: string, server: boolean, ready = true) => ({
  metadata: {
    name,
    labels: server ? { 'node-role.kubernetes.io/control-plane': 'true' } : {},
  },
  status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
});

const recorded = [
  { id: 'n-m', serverName: 'lab-master', nodeType: 'master' },
  { id: 'n-1', serverName: 'lab-worker-1', nodeType: 'worker' },
  { id: 'n-2', serverName: 'lab-worker-2', nodeType: 'worker' },
  { id: 'n-3', serverName: 'lab-worker-3', nodeType: 'worker' },
];
const overlay: Record<string, string> = {
  'n-m': '10.9.0.1',
  'n-1': '10.9.0.2',
  'n-2': '10.9.0.3',
  'n-3': '10.9.0.4',
};
const k8sNodes = [
  k8sNode('lab-master', true),
  k8sNode('lab-worker-1', true),
  k8sNode('lab-worker-2', false),
  k8sNode('lab-worker-3', true),
];

function setup(metadata: Record<string, unknown> = {}, host = '10.9.0.1') {
  const cluster: any = {
    id: 'c1',
    name: 'lab',
    kubeconfigEncrypted: kubeconfig(host),
    metadata,
    nodes: recorded,
  };
  const saved: any[] = [];
  jest
    .mocked(mergeClusterMetadata)
    .mockImplementation(async (_repo, _id, keys) => {
      saved.push({ metadata: keys });
    });
  const enrol = jest.fn(async () => ({ outcome: 'applied' }));
  const service = new ApiServerFailoverService(
    {
      update: jest.fn(async (_id, c) => saved.push({ ...c })),
      find: jest.fn(),
    } as any,
    { decrypt: (v: string) => v, encrypt: (v: string) => v } as any,
    { listNodes: jest.fn(async () => k8sNodes) } as any,
    {
      nodeOverlayFor: jest.fn(async (id: string) =>
        overlay[id] ? { nodeAddress: overlay[id], enrolled: true } : undefined,
      ),
    } as any,
    { enrolOverlayAddress: enrol } as any,
  );
  return { service, cluster, saved, enrol };
}

describe('reaching a cluster through any of its servers', () => {
  beforeEach(() => answers.mockReset());

  it('lists the servers, the master first, with the address each answers on', () => {
    expect(
      knownApiServers(k8sNodes, recorded, new Map(Object.entries(overlay))),
    ).toEqual([
      { nodeId: 'n-m', name: 'lab-master', address: '10.9.0.1' },
      { nodeId: 'n-1', name: 'lab-worker-1', address: '10.9.0.2' },
      { nodeId: 'n-3', name: 'lab-worker-3', address: '10.9.0.4' },
    ]);
    expect(readyServerCount(k8sNodes)).toBe(3);
  });

  it('while the current server answers, it learns the others and names one missing address per sweep', async () => {
    answers.mockImplementation(
      async (host) => host !== '10.9.0.2' && host !== '10.9.0.4',
    );
    const { service, cluster, saved, enrol } = setup();
    await service.check(cluster);
    expect(enrol).toHaveBeenCalledTimes(1);
    expect(enrol).toHaveBeenCalledWith('c1', 'n-1');
    expect(saved[0].metadata.apiServers.map((s: any) => s.name)).toEqual([
      'lab-master',
    ]);
  });

  it('moves to the first other server that answers when the current one does not', async () => {
    answers.mockImplementation(async (host) => host === '10.9.0.4');
    const { service, cluster, saved } = setup({
      apiServers: [
        { nodeId: 'n-m', name: 'lab-master', address: '10.9.0.1' },
        { nodeId: 'n-1', name: 'lab-worker-1', address: '10.9.0.2' },
        { nodeId: 'n-3', name: 'lab-worker-3', address: '10.9.0.4' },
      ],
    });
    await service.check(cluster);
    expect(saved[0].kubeconfigEncrypted).toContain(
      'server: https://10.9.0.4:6443',
    );
  });

  it('leaves alone a cluster a person moved back to its public address', async () => {
    answers.mockResolvedValue(false);
    const { service, cluster, saved } = setup({
      overlayDemotion: { at: 'x', by: 'p', from: 'a', to: 'b' },
      apiServers: [
        { nodeId: 'n-1', name: 'lab-worker-1', address: '10.9.0.2' },
      ],
    });
    await service.check(cluster);
    expect(saved).toEqual([]);
    expect(answers).not.toHaveBeenCalled();
  });
});
