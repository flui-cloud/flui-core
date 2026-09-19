jest.mock('@kubernetes/client-node', () => ({}));

import { ClusterCapacityService } from './cluster-capacity.service';

/**
 * A BYOS cluster has no adapter in the factory, which refuses with `Provider
 * byos not supported`.
 *
 * That is the right answer to "sell me a bigger node" and the wrong one to
 * "how much room is left" — the question this endpoint is actually asked, and
 * one the cluster answers by itself.
 */
const build = (over: { hasAdapter: boolean }) => {
  const clusterRepository = {
    findOne: async () => ({
      id: 'c1',
      provider: over.hasAdapter ? 'hetzner' : 'byos',
      kubeconfigEncrypted: 'sealed',
    }),
  };
  const nodeRepository = { findOne: async () => null };
  const providerFactory = {
    getProvider: () => {
      if (!over.hasAdapter) {
        throw new Error('Provider byos not supported. Supported: hetzner');
      }
      return { getNodeSizes: async () => [] };
    },
  };
  const encryptionService = { decrypt: () => 'kubeconfig' };
  const kubernetesService = {
    getMasterNodeCapacity: async () => ({
      nodeName: 'control-cluster-master',
      allocatable: { cpu: 6000, memory: 12000 },
      requested: { cpu: 720, memory: 1180 },
    }),
  };
  const clusterStorageService = {
    getStatus: async () => ({ volume: null }),
  };

  return new ClusterCapacityService(
    clusterRepository as never,
    nodeRepository as never,
    kubernetesService as never,
    encryptionService as never,
    providerFactory as never,
    clusterStorageService as never,
  );
};

describe('a capacity plan for machines nobody sold you', () => {
  it('answers with the room the cluster has, instead of failing', async () => {
    const plan = await build({ hasAdapter: false }).getPlan('c1');

    expect(plan.master?.freeCpuMillicores).toBe(5280);
    expect(plan.master?.freeMemoryMi).toBe(10820);
    expect(plan.candidates).toEqual([]);
  });

  it('says why there are no sizes and no prices', async () => {
    const plan = await build({ hasAdapter: false }).getPlan('c1');

    expect(plan.message).toContain('brought rather than bought');
    expect(plan.message).toContain('attaching another machine');
  });

  it('leaves a cluster with a real provider untouched', async () => {
    const plan = await build({ hasAdapter: true }).getPlan('c1');

    expect(plan.message).not.toContain('brought rather than bought');
  });
});
