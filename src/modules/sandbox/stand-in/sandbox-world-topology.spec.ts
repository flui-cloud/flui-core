jest.mock('@kubernetes/client-node', () => ({}));

import { firstValueFrom, take, toArray } from 'rxjs';
import {
  exampleTopology,
  exampleTopologyChanges,
  exampleTopologyStream,
} from './sandbox-world-topology';
import { APPS, CLUSTER_ID, MACHINES } from './sandbox-world-core';
import {
  applyScope,
  exampleScope,
} from '../../topology/services/topology-scope.service';
import { exampleClusterFirewall, exampleInstances } from './sandbox-world';
import { exampleScalingPreview } from './sandbox-world-scaling';
import { SCALING_GROUP_ID } from './sandbox-world-scaling';
import {
  TopologyAppKind,
  TopologyAppStatus,
  TopologyArchitecture,
  TopologyClusterType,
  TopologyEndpointKind,
  TopologyEventType,
  TopologyHealthStatus,
  TopologyOverlay,
} from '../../topology/enums/topology.enums';

const NOW = Date.parse('2026-10-17T15:00:00Z');
const world = exampleTopology(NOW);

describe('the example topology holds together', () => {
  const serverCluster = new Map(world.servers.map((s) => [s.id, s.clusterId]));
  const appIds = new Set(world.apps.map((a) => a.id));

  it('places every replica on a server of its own cluster', () => {
    for (const app of world.apps) {
      expect(app.replicas.length).toBeGreaterThan(0);
      for (const r of app.replicas) {
        expect(serverCluster.get(r.serverId)).toBe(app.clusterId);
      }
      expect(app.replicas.map((r) => r.serverId)).toContain(
        app.primaryServerId,
      );
      expect(app.replicaCount).toBe(
        app.replicas.reduce((s, r) => s + r.count, 0),
      );
    }
  });

  it('puts every app in exactly one stack of its own cluster', () => {
    const seen = new Map<string, number>();
    for (const stack of world.stacks) {
      expect(stack.appIds).toContain(stack.primaryAppId);
      for (const id of stack.appIds) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        const app = world.apps.find((a) => a.id === id)!;
        expect(app.stackId).toBe(stack.id);
        expect(app.clusterId).toBe(stack.clusterId);
      }
    }
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.size).toBe(world.apps.length);
  });

  it('draws every link between endpoints that exist', () => {
    for (const link of world.links) {
      for (const end of [link.from, link.to]) {
        if (end.kind === TopologyEndpointKind.APP) {
          expect(appIds.has(end.appId!)).toBe(true);
        }
      }
      expect(link.label).not.toMatch(/\.[a-z]{2,}$/);
    }
  });

  it('counts per pod what the replicas say', () => {
    const total = world.servers.reduce((s, v) => s + v.podCount, 0);
    expect(total).toBe(world.stats.totalReplicas);
  });

  it('keeps the main cluster the one every other section describes', () => {
    const main = world.servers.filter((s) => s.clusterId === CLUSTER_ID);
    expect(main.map((s) => s.id)).toEqual(MACHINES.map((m) => m.id));
    for (const app of APPS) {
      expect(world.apps.find((a) => a.id === app.id)?.clusterId).toBe(
        CLUSTER_ID,
      );
    }
    const preview = exampleScalingPreview(NOW, {}, { id: SCALING_GROUP_ID });
    const room = (preview as unknown as { room: { nodes: { name: string }[] } })
      .room;
    expect(room.nodes.map((n) => n.name)).toEqual(MACHINES.map((m) => m.name));
  });

  it('lists every server among the instances, under the provider id its link opens', () => {
    const instances = exampleInstances(NOW).data;
    for (const server of world.servers) {
      const instance = instances.find((i) => i.id === server.id);
      expect(instance).toMatchObject({
        provider: server.provider,
        providerId: server.providerResourceId,
        name: server.nodeName,
      });
    }
  });
});

describe('the example topology looks like a small shop in production', () => {
  const byName = (cluster: string) =>
    world.clusters.find((c) => c.name === cluster)!;
  const appsOf = (cluster: string) =>
    world.apps
      .filter((a) => a.clusterId === byName(cluster).id)
      .map((a) => a.name);

  it('has a production, a staging and a control cluster, on real regions', () => {
    expect(
      world.clusters.map((c) => [c.name, c.provider, c.region, c.type]),
    ).toEqual([
      ['production', 'hetzner', 'fsn1', TopologyClusterType.WORKLOAD],
      ['staging', 'scaleway', 'fr-par', TopologyClusterType.WORKLOAD],
      ['flui-control', 'hetzner', 'nbg1', TopologyClusterType.CONTROL],
    ]);
    expect(
      world.clusters.every((c) => c.overlay === TopologyOverlay.TUNNEL),
    ).toBe(true);
  });

  it('runs production on one control plane and two workers, the others on one server each', () => {
    const servers = (cluster: string) =>
      world.servers
        .filter((s) => s.clusterId === byName(cluster).id)
        .map((s) => `${s.nodeName}:${s.serverType}:${s.role}`);
    expect(servers('production')).toEqual([
      'production-1:cx33:control-plane',
      'production-2:cx43:worker',
      'production-3:cx43:worker',
    ]);
    expect(servers('staging')).toEqual(['staging-1:DEV1-L:control-plane']);
    expect(servers('flui-control')).toEqual([
      'flui-control-1:cx33:control-plane',
    ]);
    for (const server of world.servers) {
      expect(server.architecture).toBe(TopologyArchitecture.X86);
      expect(server.capacity!.usedMemPct).toBeGreaterThanOrEqual(30);
      expect(server.capacity!.usedMemPct).toBeLessThanOrEqual(75);
    }
  });

  it('runs the shop and its sites in production, a smaller copy in staging', () => {
    expect(appsOf('production').sort()).toEqual(
      [
        'api',
        'docs',
        'meilisearch',
        'postgres',
        'redis',
        'storefront',
        'umami',
        'worker',
      ].sort(),
    );
    expect(appsOf('staging').sort()).toEqual(['api', 'postgres', 'storefront']);
  });

  it('keeps replicas modest: two of what serves requests, one of the rest', () => {
    const replicas = Object.fromEntries(
      world.apps
        .filter((a) => a.clusterId === CLUSTER_ID)
        .map((a) => [a.name, a.replicaCount]),
    );
    expect(replicas.api).toBe(2);
    expect([2, 3]).toContain(replicas.storefront);
    for (const name of ['worker', 'postgres', 'redis', 'meilisearch']) {
      expect(replicas[name]).toBe(1);
    }
    expect(world.apps.every((a) => a.replicaCount <= 3)).toBe(true);
  });

  it('keeps user apps off the production control plane', () => {
    const master = world.servers.find((s) => s.nodeName === 'production-1')!;
    expect(master.takesWork).toBe(false);
    expect(world.apps.some((a) => a.primaryServerId === master.id)).toBe(false);
  });

  it('links the shop the way a real one is wired, inside each cluster', () => {
    const named = (id: string | undefined) =>
      world.apps.find((a) => a.id === id)!;
    const edges = world.links
      .filter((l) => l.from.kind === TopologyEndpointKind.APP)
      .filter((l) => named(l.from.appId).kind !== TopologyAppKind.SYSTEM)
      .map((l) => {
        const from = named(l.from.appId);
        const cluster = world.clusters.find((c) => c.id === from.clusterId)!;
        return `${cluster.name}: ${from.name}>${named(l.to.appId).name}`;
      });
    expect(edges.sort()).toEqual(
      [
        'production: storefront>api',
        'production: api>postgres',
        'production: api>redis',
        'production: api>meilisearch',
        'production: worker>postgres',
        'production: worker>redis',
        'production: umami>postgres',
        'staging: storefront>api',
        'staging: api>postgres',
      ].sort(),
    );
  });

  it('publishes the storefront, the docs and the analytics, and nothing internal', () => {
    const routed = world.links
      .filter((l) => l.from.kind === TopologyEndpointKind.INTERNET)
      .map((l) => world.apps.find((a) => a.id === l.to.appId)!)
      .filter((a) => a.kind !== TopologyAppKind.SYSTEM)
      .map((a) => `${a.clusterId === CLUSTER_ID ? '' : 'staging '}${a.name}`);
    expect(routed.sort()).toEqual(
      ['docs', 'staging storefront', 'storefront', 'umami'].sort(),
    );
  });

  it('runs the same shop on two clusters under the same groups', () => {
    const byGroup = new Map<string, Set<string>>();
    for (const app of world.apps) {
      const clusters = byGroup.get(app.groupKey) ?? new Set<string>();
      clusters.add(app.clusterId);
      byGroup.set(app.groupKey, clusters);
    }
    expect(
      [...byGroup.entries()]
        .filter(([, c]) => c.size > 1)
        .map(([key]) => key)
        .sort(),
    ).toEqual(['group:api', 'group:postgres', 'group:storefront']);
  });

  it('measures modest traffic on gateway routes only', () => {
    for (const link of world.links) {
      if (link.from.kind === TopologyEndpointKind.INTERNET) {
        expect(link.traffic.measured).toBe(true);
        expect(link.traffic.rps).toBeGreaterThan(0);
        expect(link.traffic.rps).toBeLessThanOrEqual(40);
        expect(link.traffic.errorPct).toBeLessThan(1);
      } else {
        expect(link.traffic).toEqual({
          measured: false,
          rps: null,
          errorPct: null,
        });
      }
    }
  });

  it('says where each route answers and which app port it reaches', () => {
    for (const link of world.links) {
      const route = link.from.kind === TopologyEndpointKind.INTERNET;
      expect(link.routePath === null).toBe(!route);
      if (route) {
        expect(link.routePath).toMatch(/^\//);
        expect(world.apps.find((a) => a.id === link.to.appId)).toBeDefined();
        expect(link.targetPort).toBeGreaterThan(0);
      } else {
        expect(link.targetPort).toBeNull();
      }
    }
  });

  it('opens the ports the example firewall page lists, on every cluster', () => {
    const page = exampleClusterFirewall(NOW, { clusterId: CLUSTER_ID });
    const main = world.clusters.find((c) => c.id === CLUSTER_ID)!;
    const byText = (a: string | null, b: string | null) =>
      (a ?? '').localeCompare(b ?? '');
    expect(main.inbound!.map((r) => r.port).sort(byText)).toEqual(
      page.desiredRules
        .filter((r: { direction: string }) => r.direction === 'in')
        .map((r: { port: string }) => r.port)
        .sort(byText),
    );
    expect(main.inbound!.find((r) => r.port === '443')!.fromAnywhere).toBe(
      true,
    );
    expect(main.inbound!.find((r) => r.port === '22')!.fromAnywhere).toBe(
      false,
    );
    for (const cluster of world.clusters) {
      expect(cluster.inbound).not.toBeNull();
    }
  });

  it('puts every user app in a project, in that project namespace, and platform apps in none', () => {
    const projects = new Map(world.projects.map((p) => [p.id, p.name]));
    expect([...projects.values()]).toEqual(['Shop', 'Website']);
    for (const app of world.apps) {
      if (app.kind === TopologyAppKind.SYSTEM) {
        expect(app.projectId).toBeNull();
      } else {
        expect(projects.has(app.projectId!)).toBe(true);
        expect(app.namespace).toBe(
          `p-${projects.get(app.projectId!)!.toLowerCase()}`,
        );
      }
    }
  });

  it('connects every server to the Flui network', () => {
    expect(world.servers.every((s) => s.fluiNetwork === 'active')).toBe(true);
    expect(world.servers.every((s) => s.privateNetwork)).toBe(true);
  });

  it('links apps only within their cluster, as Flui does', () => {
    expect(world.links.filter((l) => l.crossCluster)).toHaveLength(0);
    expect(world.clusterLinks).toHaveLength(0);
  });

  it('has exactly one problem: the worker running into its memory limit', () => {
    expect(world.stats.errorCount).toBe(0);
    const troubled = world.apps.filter(
      (a) => a.status !== TopologyAppStatus.RUNNING,
    );
    expect(troubled.map((a) => [a.name, a.status])).toEqual([
      ['worker', TopologyAppStatus.WARNING],
    ]);
    expect(troubled[0].statusReason).toMatch(/OOMKilled/);
    expect(troubled[0].ramLimitMB - troubled[0].ramRequestMB).toBeLessThan(
      troubled[0].ramRequestMB / 2,
    );
    expect(
      world.clusters.every((c) => c.status === TopologyHealthStatus.HEALTHY),
    ).toBe(true);
  });
});

describe('the example control cluster runs what Flui runs for itself', () => {
  const control = world.clusters.find(
    (c) => c.type === TopologyClusterType.CONTROL,
  )!;
  const platform = world.apps.filter((a) => a.kind === TopologyAppKind.SYSTEM);
  const bySlug = (name: string) => platform.find((a) => a.name === name)!;
  const controlServers = new Set(
    world.servers.filter((s) => s.clusterId === control.id).map((s) => s.id),
  );

  it('flags every app Flui labels as its own as system, on the control cluster only', () => {
    expect(platform.map((a) => a.name).sort()).toEqual(
      [
        'alertmanager',
        'flui-api',
        'flui-web',
        'grafana',
        'kube-state-metrics',
        'loki',
        'postgres',
        'redis',
        'vmagent',
        'vmalert',
        'vmsingle',
        'zitadel',
      ].sort(),
    );
    for (const app of platform) {
      expect(app.clusterId).toBe(control.id);
      expect(app.projectId).toBeNull();
      for (const r of app.replicas)
        expect(controlServers.has(r.serverId)).toBe(true);
    }
    expect(
      world.apps.filter(
        (a) => a.clusterId === control.id && a.kind !== TopologyAppKind.SYSTEM,
      ),
    ).toHaveLength(0);
  });

  it('puts each one in the namespace its manifests install it in', () => {
    expect(bySlug('flui-api').namespace).toBe('flui-system');
    expect(bySlug('postgres').namespace).toBe('flui-system');
    expect(bySlug('zitadel').namespace).toBe('flui-system');
    expect(bySlug('vmsingle').namespace).toBe('flui-control');
    expect(bySlug('alertmanager').namespace).toBe('flui-control');
  });

  it('links them inside the control cluster, on the ports they listen on', () => {
    const label = (from: string, to: string) =>
      world.links.find(
        (l) => l.from.appId === bySlug(from).id && l.to.appId === bySlug(to).id,
      )?.label;
    expect(label('flui-api', 'postgres')).toBe(':5432');
    expect(label('flui-api', 'redis')).toBe(':6379');
    expect(label('zitadel', 'postgres')).toBe(':5432');
    expect(label('vmagent', 'vmsingle')).toBe(':8428');
    expect(label('vmalert', 'vmsingle')).toBe(':8428');
    expect(label('vmalert', 'alertmanager')).toBe(':9093');
    expect(label('grafana', 'loki')).toBe(':3100');
    const ids = new Set(platform.map((a) => a.id));
    for (const link of world.links.filter(
      (l) => l.from.appId && ids.has(l.from.appId),
    )) {
      expect(ids.has(link.to.appId!)).toBe(true);
      expect(link.crossCluster).toBe(false);
    }
  });

  it('keeps the control servers requested below what they hold', () => {
    for (const server of world.servers.filter((s) =>
      controlServers.has(s.id),
    )) {
      const c = server.capacity!;
      expect(c.requestedMemMi).toBeLessThan(c.allocatableMemMi! * 0.5);
      expect(c.requestedCpuM).toBeLessThan(c.allocatableCpuM! * 0.75);
    }
  });

  it('shows them to a guest who asks for system apps, and only then', () => {
    const shown = applyScope(world, exampleScope(world, true));
    const hidden = applyScope(world, exampleScope(world, false));
    expect(
      shown.apps.filter((a) => a.kind === TopologyAppKind.SYSTEM),
    ).toHaveLength(platform.length);
    expect(hidden.apps.some((a) => a.kind === TopologyAppKind.SYSTEM)).toBe(
      false,
    );
    expect(shown.clusters.find((c) => c.id === control.id)!.counts.apps).toBe(
      platform.length,
    );
  });
});

describe('the example topology is deterministic and alive', () => {
  it('draws the same picture for the same moment', () => {
    expect(exampleTopology(NOW)).toEqual(world);
  });

  it('scales the storefront, drifts capacity and moves traffic, without flapping a status', () => {
    const events: TopologyEventType[] = [];
    for (let t = NOW; t < NOW + 720_000; t += 5_000) {
      events.push(...exampleTopologyChanges(t, t + 5_000).map((c) => c.event));
    }
    const count = (e: TopologyEventType) =>
      events.filter((x) => x === e).length;
    expect(count(TopologyEventType.APP_STATUS_CHANGED)).toBe(0);
    expect(count(TopologyEventType.APP_SCALED)).toBe(2);
    expect(count(TopologyEventType.SERVER_CAPACITY)).toBe(24);
    expect(count(TopologyEventType.LINKS_CHANGED)).toBe(72);
    expect(count(TopologyEventType.HEARTBEAT)).toBe(48);
  });

  it('streams the same events as the change function, tick by tick', async () => {
    let t = NOW;
    const clock = () => {
      const now = t;
      t += 5_000;
      return now;
    };
    const streamed = await firstValueFrom(
      exampleTopologyStream(clock, 1).pipe(take(10), toArray()),
    );
    const expected = [];
    let at = NOW;
    while (expected.length < 10) {
      expected.push(...exampleTopologyChanges(at, at + 5_000));
      at += 5_000;
    }
    expect(streamed).toEqual(expected.slice(0, 10));
  });
});
