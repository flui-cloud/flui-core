jest.mock('@kubernetes/client-node', () => ({}));

import { DbPodPlacementService } from './db-pod-placement.service';

function setup(nodes: any[], live: Record<string, boolean>) {
  const svc = new DbPodPlacementService(
    {} as any,
    {} as any,
    { find: jest.fn(async () => nodes) } as any,
    {
      nodeOverlayFor: jest.fn(async (id: string) =>
        id in live
          ? { nodeAddress: '10.250.0.9', enrolled: live[id] }
          : undefined,
      ),
    } as any,
  );
  return svc;
}

const master = {
  id: 'm',
  serverName: 'b-master',
  nodeType: 'master',
  status: 'ready',
};
const worker = {
  id: 'w',
  serverName: 'b-worker-1',
  nodeType: 'worker',
  status: 'ready',
};

describe('DbPodPlacementService.assertTargetReady', () => {
  it('accepts a master-only cluster whose master is live on the Flui network', async () => {
    await expect(
      setup([master], { m: true }).assertTargetReady('b'),
    ).resolves.toBeUndefined();
  });

  it('refuses a master-only cluster whose master is not live, naming it', async () => {
    await expect(
      setup([master], { m: false }).assertTargetReady('b'),
    ).rejects.toThrow(/b-master.*not live on the Flui network/);
  });

  it('looks at the workers, not the master, when the cluster has workers', async () => {
    await expect(
      setup([master, worker], { m: false, w: true }).assertTargetReady('b'),
    ).resolves.toBeUndefined();
    await expect(
      setup([master, worker], { m: true }).assertTargetReady('b'),
    ).rejects.toThrow(/b-worker-1/);
  });

  it('refuses a cluster with no node ready to take the database', async () => {
    await expect(
      setup([{ ...master, status: 'creating' }], {}).assertTargetReady('b'),
    ).rejects.toThrow(/no node ready/);
  });
});
