import { exampleTopology } from '../../sandbox/stand-in/sandbox-world-topology';
import {
  appSlice,
  attentionOf,
  clusterSlice,
  findApp,
  findCluster,
  findServer,
  missMessage,
  serverSlice,
  spreadOf,
  trafficIn,
} from './topology-slice.util';

const QUIET = 1792663200000;
const t = exampleTopology(QUIET);

describe('topology slice', () => {
  it('finds a cluster by id or by name in any case', () => {
    expect(findCluster(t, 'example-cluster-1')).toEqual({
      found: expect.objectContaining({ name: 'production' }),
    });
    expect(findCluster(t, 'PRODUCTION')).toEqual({
      found: expect.objectContaining({ id: 'example-cluster-1' }),
    });
  });

  it('returns every candidate when an app name is on several clusters', () => {
    const match = findApp(t, 'storefront');
    expect('candidates' in match && match.candidates).toHaveLength(2);
    const message = missMessage(
      t,
      'app',
      'storefront',
      'candidates' in match ? match.candidates : [],
    );
    expect(message).toContain('"storefront" matches 2 apps');
    expect(message).toContain('production');
    expect(message).toContain('staging');
    expect(message).toContain('Pass --cluster or the id');
  });

  it('narrows an app or a server to one cluster', () => {
    expect(findApp(t, 'Storefront', 'staging')).toEqual({
      found: expect.objectContaining({ clusterId: 'example-cluster-2' }),
    });
    expect(findServer(t, 'production-2', 'production')).toEqual({
      found: expect.objectContaining({ nodeName: 'production-2' }),
    });
  });

  it('names the clusters when the cluster to look in does not exist', () => {
    const match = findApp(t, 'storefront', 'nowhere');
    expect(match).toEqual({ candidates: [] });
    expect(missMessage(t, 'app', 'storefront', [], 'nowhere')).toBe(
      'No cluster named "nowhere". Clusters: production, staging, flui-control.',
    );
  });

  it('lists what exists when nothing matches', () => {
    expect(missMessage(t, 'server', 'nope', [])).toMatch(
      /^No server named "nope"\. Servers: production-1, production-2/,
    );
  });

  it('sums measured requests from the Internet, and says null when none are measured', () => {
    expect(trafficIn(t, 'example-app-1')).toBeGreaterThan(0);
    expect(trafficIn(t, 'example-app-4')).toBeNull();
  });

  it('cuts the snapshot to one cluster, one app or one server', () => {
    const cluster = clusterSlice(t, 'example-cluster-1');
    expect(cluster.apps.every((a) => a.clusterId === 'example-cluster-1')).toBe(
      true,
    );
    expect(
      cluster.projects.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['Shop', 'Website']);

    const app = appSlice(t, 'example-app-1');
    expect(
      app.servers.map((s) => s.nodeName).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['production-2', 'production-3']);
    expect(app.peers.map((a) => a.displayName)).toContain('API');

    const server = serverSlice(t, 'example-server-2');
    expect(server.apps.map((a) => a.displayName)).toContain('Storefront');
  });

  it('puts a troubled app on the attention list with its reason', () => {
    const items = attentionOf(t);
    expect(items[0]).toMatchObject({
      type: 'app',
      label: 'Worker',
      detail: 'Restarted 3 times in the last hour · OOMKilled',
      severity: 'warning',
    });
  });

  it('leaves platform apps out of the spread, since every cluster runs them', () => {
    const platform = t.apps.find((a) => a.kind === 'system')!;
    const elsewhere = t.clusters.find((c) => c.id !== platform.clusterId)!;
    const withCopy = {
      ...t,
      apps: [
        ...t.apps,
        { ...platform, id: 'platform-copy', clusterId: elsewhere.id },
      ],
    };
    expect(spreadOf(withCopy).map((s) => s.label)).not.toContain(
      platform.displayName,
    );
  });

  it('lists the apps that run on several clusters', () => {
    expect(spreadOf(t)).toContainEqual({
      appId: 'example-app-1',
      label: 'Storefront',
      clusters: ['production', 'staging'],
    });
  });
});
