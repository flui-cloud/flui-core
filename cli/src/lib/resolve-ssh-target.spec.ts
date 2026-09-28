jest.mock('./repositories/cli-cluster.repository', () => ({
  CliClusterRepository: jest.fn().mockImplementation(() => ({
    find: async () => [
      {
        id: 'c1',
        name: 'control-cluster-x',
        clusterType: 'control',
        masterIpAddress: '203.0.113.10',
        nodes: [
          { nodeType: 'master', ipAddress: '203.0.113.10', serverName: 'm' },
        ],
      },
    ],
  })),
}));
const listClusters = jest.fn();
jest.mock('./cluster-listing', () => ({
  listClusters: (...a: unknown[]) => listClusters(...a),
}));

import { resolveSshTarget } from './resolve-ssh-target';

describe('resolveSshTarget', () => {
  beforeEach(() => listClusters.mockReset());

  it("reaches the control from this machine's record without asking the API", async () => {
    const resolved = await resolveSshTarget('master');
    expect(resolved.target.host).toBe('203.0.113.10');
    expect(resolved.clusterName).toBe('control-cluster-x');
    expect(listClusters).not.toHaveBeenCalled();
  });

  it('also by name', async () => {
    await resolveSshTarget('control-cluster-x/master');
    expect(listClusters).not.toHaveBeenCalled();
  });

  it('asks the API for a cluster this machine does not know', async () => {
    listClusters.mockResolvedValue({ clusters: [], apiError: 'down' });
    await expect(resolveSshTarget('workload-1/master')).rejects.toThrow('down');
    expect(listClusters).toHaveBeenCalled();
  });
});
