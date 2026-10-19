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
  TopologyOverlay,
  TopologyStackType,
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

describe('the example topology looks like a real, busy fleet', () => {
  it('has a handful of clusters, one of them held on its public address', () => {
    expect(world.clusters.length).toBeGreaterThanOrEqual(4);
    expect(
      world.clusters.filter(
        (c) => c.overlay === TopologyOverlay.PUBLIC_ADDRESS,
      ),
    ).toHaveLength(1);
  });

  it('has 16 to 20 servers, at least two of them arm, one of them nearly full', () => {
    expect(world.servers.length).toBeGreaterThanOrEqual(16);
    expect(world.servers.length).toBeLessThanOrEqual(20);
    expect(
      world.servers.filter((s) => s.architecture === TopologyArchitecture.ARM)
        .length,
    ).toBeGreaterThanOrEqual(2);
    const memory = world.servers.map((s) => s.capacity!.usedMemPct!);
    expect(memory.filter((m) => m >= 90)).toHaveLength(1);
    expect(memory.filter((m) => m >= 90)[0]).toBeLessThanOrEqual(94);
    expect(Math.min(...memory)).toBeGreaterThanOrEqual(30);
  });

  it('has 60 to 80 apps in 12 or more composed stacks', () => {
    expect(world.apps.length).toBeGreaterThanOrEqual(60);
    expect(world.apps.length).toBeLessThanOrEqual(80);
    expect(
      world.stacks.filter((s) => s.type === TopologyStackType.COMPOSED).length,
    ).toBeGreaterThanOrEqual(12);
  });

  it('runs one app on two clusters under one group', () => {
    const byGroup = new Map<string, Set<string>>();
    for (const app of world.apps) {
      const clusters = byGroup.get(app.groupKey) ?? new Set<string>();
      clusters.add(app.clusterId);
      byGroup.set(app.groupKey, clusters);
    }
    expect([...byGroup.values()].filter((c) => c.size > 1)).toHaveLength(1);
  });

  it('piles more than half of one app on one server, exactly once', () => {
    const piled = world.apps.filter(
      (a) =>
        a.replicaCount >= 2 &&
        a.replicas.some((r) => r.count > a.replicaCount / 2),
    );
    expect(piled.map((a) => a.name)).toEqual(['orders-api']);
  });

  it('measures traffic on gateway routes only, within a believable range', () => {
    for (const link of world.links) {
      if (link.from.kind === TopologyEndpointKind.INTERNET) {
        expect(link.traffic.measured).toBe(true);
        expect(link.traffic.rps).toBeGreaterThanOrEqual(0.5);
        expect(link.traffic.rps).toBeLessThanOrEqual(460);
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

  it('opens the ports the example firewall page lists, and shows the Contabo cluster without one', () => {
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

  it('puts apps in a few projects that exist, platform apps and a few strays in none', () => {
    const ids = new Set(world.projects.map((p) => p.id));
    expect(ids.size).toBeGreaterThanOrEqual(3);
    for (const app of world.apps) {
      if (app.projectId) expect(ids.has(app.projectId)).toBe(true);
      if (app.kind === 'system') expect(app.projectId).toBeNull();
    }
    const strays = world.apps.filter(
      (a) => !a.projectId && a.kind !== 'system',
    );
    expect(strays.length).toBeGreaterThan(0);
    for (const id of ids)
      expect(world.apps.some((a) => a.projectId === id)).toBe(true);
  });

  it('connects every server to the Flui network but the held cluster and one newcomer', () => {
    const off = world.servers.filter((s) => s.fluiNetwork !== 'active');
    expect(off.map((s) => `${s.nodeName}:${s.fluiNetwork}`)).toEqual([
      'us-worker-4:pending',
      'asia-node-1:stale',
      'asia-node-2:stale',
      'asia-node-3:stale',
    ]);
    const held = world.clusters.find(
      (c) => c.overlay === TopologyOverlay.PUBLIC_ADDRESS,
    )!;
    expect(
      world.servers
        .filter((s) => !s.privateNetwork)
        .every((s) => s.clusterId === held.id),
    ).toBe(true);
  });

  it('links apps only within their cluster, as Flui does', () => {
    expect(world.links.filter((l) => l.crossCluster)).toHaveLength(0);
    expect(world.clusterLinks).toHaveLength(0);
  });

  it('has a few believable problems and no wall of red', () => {
    expect(
      world.stats.errorCount + world.stats.warningCount,
    ).toBeLessThanOrEqual(3);
    expect(world.stats.warningCount).toBeGreaterThanOrEqual(1);
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

  it('flags every platform app as system, on the control cluster only', () => {
    expect(platform.map((a) => a.name).sort()).toEqual(
      [
        'alertmanager',
        'cert-manager',
        'cert-manager-cainjector',
        'cert-manager-webhook',
        'coredns',
        'flui-api',
        'flui-web',
        'grafana',
        'kube-state-metrics',
        'loki',
        'metrics-server',
        'postgres',
        'redis',
        'traefik',
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
    expect(bySlug('traefik').namespace).toBe('kube-system');
    expect(bySlug('cert-manager').namespace).toBe('cert-manager');
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

  it('flaps the billing API, scales the storefront, drifts capacity and moves traffic within three minutes', () => {
    const events: TopologyEventType[] = [];
    for (let t = NOW; t < NOW + 180_000; t += 5_000) {
      events.push(...exampleTopologyChanges(t, t + 5_000).map((c) => c.event));
    }
    const count = (e: TopologyEventType) =>
      events.filter((x) => x === e).length;
    expect(count(TopologyEventType.APP_STATUS_CHANGED)).toBeGreaterThanOrEqual(
      8,
    );
    expect(count(TopologyEventType.APP_SCALED)).toBe(2);
    expect(count(TopologyEventType.SERVER_CAPACITY)).toBe(6);
    expect(count(TopologyEventType.LINKS_CHANGED)).toBe(18);
    expect(count(TopologyEventType.HEARTBEAT)).toBe(12);
  });

  it('flaps only between warning and error', () => {
    for (let t = NOW; t < NOW + 120_000; t += 5_000) {
      for (const change of exampleTopologyChanges(t, t + 5_000)) {
        if (change.event === TopologyEventType.APP_STATUS_CHANGED) {
          expect([
            TopologyAppStatus.WARNING,
            TopologyAppStatus.ERROR,
          ]).toContain(change.data.status);
        }
      }
    }
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
