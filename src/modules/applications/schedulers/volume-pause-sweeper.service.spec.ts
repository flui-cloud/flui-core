// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; the sweeper reaches it through the lease service, stubbed here.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { VolumePauseSweeperService } from './volume-pause-sweeper.service';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';

/**
 * The sweep is housekeeping. What these tests protect is that it never becomes
 * a precondition for the control plane answering at all.
 *
 * `onApplicationBootstrap` runs before `app.listen()`. Awaiting a sweep that
 * talks to every cluster meant one powered-off workload cluster stopped the API
 * from starting: a host that is off swallows the packets rather than refusing
 * them, the kernel takes about 133 seconds to give up, and the liveness probe
 * kills the pod at 90. Seen on a real installation, where the API crashlooped
 * from the moment a workload cluster was stopped — the exact moment somebody
 * needs the control plane in order to recover it.
 */
describe('VolumePauseSweeperService', () => {
  function make(clusters: Array<Record<string, unknown>>, sweep?: jest.Mock) {
    const find = jest.fn(async () => clusters);
    const service = Object.create(
      VolumePauseSweeperService.prototype,
    ) as VolumePauseSweeperService;
    const sweepEverywhere = (force: boolean, reason: string): Promise<void> =>
      (
        service as unknown as {
          sweepEverywhere(f: boolean, r: string): Promise<void>;
        }
      ).sweepEverywhere(force, reason);
    const r = service as unknown as Record<string, unknown>;
    r.logger = { log: jest.fn(), warn: jest.fn() };
    r.clusterRepository = { find };
    r.encryptionService = { decrypt: (v: string) => v };
    r.pauseLease = { sweep: sweep ?? jest.fn(async () => 0) };
    return { service, find, sweepEverywhere };
  }

  it('returns from the boot hook while the sweep is still in flight', async () => {
    let release: (n: number) => void = () => {};
    const blocked = new Promise<number>((resolve) => {
      release = resolve;
    });
    const sweep = jest.fn(() => blocked);
    const { service } = make([{ id: 'c-1', kubeconfigEncrypted: 'kc' }], sweep);

    // Synchronous by signature: there is no promise here for Nest to await, so
    // `app.listen()` cannot be held behind a cluster that does not answer.
    const returned: void = service.onApplicationBootstrap();
    expect(returned).toBeUndefined();

    release(0);
    await blocked;
  });

  it('asks the database only for clusters that might answer', async () => {
    // A cluster Flui has recorded as lost or stopped has no lease to release
    // and costs the whole connect timeout to establish that.
    const { find, sweepEverywhere } = make([]);
    await sweepEverywhere(true, 'boot');

    const where = (find.mock.calls[0] as unknown as [{ where: unknown }])[0]
      .where;
    // The operator objects are TypeORM internals; what matters is that both
    // states appear in the query at all, so the database does the excluding.
    const rendered = JSON.stringify(where);
    expect(rendered).toContain(ClusterStatus.LOST);
    expect(rendered).toContain(ClusterStatus.STOPPED);
  });

  it('keeps going when one cluster fails, so the others still get their leases back', async () => {
    const sweep = jest
      .fn()
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
      .mockResolvedValueOnce(2);
    const { sweepEverywhere } = make(
      [
        { id: 'c-dead', kubeconfigEncrypted: 'kc1' },
        { id: 'c-live', kubeconfigEncrypted: 'kc2' },
      ],
      sweep,
    );

    await sweepEverywhere(true, 'boot');
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
