// The service pulls in the provider graph, which reaches ESM-only packages
// Jest cannot load. Stub them: none is exercised here.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ServersService } from './servers.service';

/**
 * A server's name is not proof of whose it is.
 *
 * Two Flui installations sharing one provider account both number their first
 * workload cluster `-1`, so the names collide by construction rather than by
 * bad luck. Adopting on a name match alone builds a cluster on a machine that
 * belongs to someone else — and attaching this cluster's firewall to it would
 * cut off everything its own installation needs, because a Hetzner server with
 * no firewall allows all traffic while one with a firewall allows only what
 * the firewall lists.
 */
describe('ServersService ownership guard', () => {
  const service = Object.create(ServersService.prototype) as ServersService;
  const assert = (existing: unknown, config: unknown) =>
    (
      service as unknown as {
        assertServerIsOurs: (a: unknown, b: unknown) => void;
      }
    ).assertServerIsOurs(existing, config);

  const ours = { key: 'managed-by', value: 'flui-cloud' };
  const config = (clusterId: string) => ({
    name: 'workload-cluster-1-master',
    labels: [ours, { key: 'flui-cluster-id', value: clusterId }],
  });

  it('adopts a server that belongs to the cluster being created', () => {
    // The legitimate case: a retry of this same creation, where the server was
    // made and the job died before it was recorded.
    expect(() =>
      assert(
        {
          id: '1',
          labels: [ours, { key: 'flui-cluster-id', value: 'cluster-a' }],
        },
        config('cluster-a'),
      ),
    ).not.toThrow();
  });

  it('refuses a same-named server belonging to another installation', () => {
    expect(() =>
      assert(
        {
          id: '1',
          labels: [ours, { key: 'flui-cluster-id', value: 'cluster-b' }],
        },
        config('cluster-a'),
      ),
    ).toThrow(/belongs to another Flui cluster/);
  });

  it('refuses a same-named server Flui never created', () => {
    // No `managed-by` at all: someone else's machine that happens to share the
    // name. Touching it is never right.
    expect(() => assert({ id: '1', labels: [] }, config('cluster-a'))).toThrow(
      /not created by Flui/,
    );
  });

  it('names the server so the message can be acted on', () => {
    // The failure this replaces said "Failed to fetch kubeconfig within 15
    // minutes" — the symptom, forty-five minutes late, with no way to tell
    // what to do about it.
    expect(() =>
      assert(
        {
          id: '1',
          labels: [ours, { key: 'flui-cluster-id', value: 'cluster-b' }],
        },
        config('cluster-a'),
      ),
    ).toThrow(/workload-cluster-1-master/);
  });
});
