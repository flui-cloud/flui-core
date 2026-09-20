// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { AdmissionRefusedError, KubernetesService } from './kubernetes.service';

/**
 * Waiting out a refusal. `waitForReady` polled readiness and nothing else, so a
 * workload whose pods were refused never became ready and never said why — five
 * minutes later the caller reported a timeout, which names no cause.
 */
describe('waiting for a workload that will never be ready', () => {
  const serviceWith = (resource: unknown) => {
    const service = new KubernetesService();
    jest.spyOn(service, 'getResource').mockResolvedValue(resource as never);
    return service;
  };

  const deployment = (message?: string, type = 'ReplicaFailure') => ({
    status: {
      readyReplicas: 0,
      replicas: 1,
      conditions: [{ type, status: 'True', message }],
    },
  });

  it('stops as soon as the cluster says the pods were refused', async () => {
    const service = serviceWith(
      deployment(
        'pods "web-1" is forbidden: maximum ephemeral-storage usage per Container is 4Gi, but limit is 8Gi',
      ),
    );
    await expect(
      service.waitForReady('kc', 'Deployment', 'web', 'ns', 60_000),
    ).rejects.toBeInstanceOf(AdmissionRefusedError);
  });

  /**
   * The product already knows how to say a limit refusal in words somebody can
   * act on; this only had to look in the right place for it.
   */
  it('says it in the product’s own words when it can', async () => {
    const service = serviceWith(
      deployment(
        'pods "web-1" is forbidden: exceeded quota: sandbox-quota, requested: pods=1, used: pods=12, limited: pods=12',
      ),
    );
    await expect(
      service.waitForReady('kc', 'Deployment', 'web', 'ns', 60_000),
    ).rejects.toThrow(/pods/i);
  });

  /**
   * A refusal it cannot phrase is still a refusal. Dropping it would be the old
   * behaviour with extra steps.
   */
  it('relays a message it cannot translate rather than waiting anyway', async () => {
    const service = serviceWith(
      deployment(
        'pods "web-1" is forbidden: violates PodSecurity "restricted"',
      ),
    );
    await expect(
      service.waitForReady('kc', 'Deployment', 'web', 'ns', 60_000),
    ).rejects.toThrow(/PodSecurity/);
  });

  it('keeps waiting through a condition that is not a refusal', async () => {
    const service = serviceWith(deployment('rolling out', 'Progressing'));
    await expect(
      service.waitForReady('kc', 'Deployment', 'web', 'ns', 1_000),
    ).rejects.toThrow(/Timeout/);
  }, 15_000);

  it('keeps waiting when nothing has failed yet', async () => {
    const service = serviceWith({ status: { readyReplicas: 0, replicas: 1 } });
    await expect(
      service.waitForReady('kc', 'Deployment', 'web', 'ns', 1_000),
    ).rejects.toThrow(/Timeout/);
  }, 15_000);
});
