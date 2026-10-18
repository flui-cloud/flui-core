jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  Metrics: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { Subject, firstValueFrom, toArray, take } from 'rxjs';
import { TopologyScopeService, scopeChange } from './topology-scope.service';
import { TopologyChange } from './topology-events.service';
import {
  TopologyAppDto,
  TopologyLinkDto,
  TopologyResponseDto,
} from '../dto/topology.dto';
import {
  TopologyAppStatus,
  TopologyEndpointKind,
  TopologyEventType,
  TopologyStackType,
} from '../enums/topology.enums';
import { assembleResponse } from './topology.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const B1 = '33333333-3333-4333-8333-333333333333';

function app(
  id: string,
  clusterId: string,
  status = 'running',
): TopologyAppDto {
  return {
    id,
    clusterId,
    stackId: 'stack-a',
    status,
    replicaCount: 1,
    ramRequestMB: 128,
    replicas: [],
  } as unknown as TopologyAppDto;
}

function link(from: string | null, to: string): TopologyLinkDto {
  return {
    id: `${from}->${to}`,
    from: from
      ? { kind: TopologyEndpointKind.APP, appId: from }
      : { kind: TopologyEndpointKind.INTERNET },
    to: { kind: TopologyEndpointKind.APP, appId: to },
  } as TopologyLinkDto;
}

function topology(): TopologyResponseDto {
  const apps = [
    { ...app(A1, 'cluster-a'), projectId: 'p-shop' },
    { ...app(A2, 'cluster-a', TopologyAppStatus.ERROR), projectId: 'p-shop' },
    { ...app(B1, 'cluster-b'), projectId: 'p-secret' },
  ];
  return {
    ...assembleResponse({
      clusters: [
        { id: 'cluster-a', counts: { apps: 2 } },
        { id: 'cluster-b', counts: { apps: 1 } },
      ] as never,
      servers: [
        { id: 'node-a', clusterId: 'cluster-a' },
        { id: 'node-b', clusterId: 'cluster-b' },
      ] as never,
      stacks: [
        {
          id: 'stack-a',
          clusterId: 'cluster-a',
          type: TopologyStackType.COMPOSED,
          primaryAppId: A2,
          appIds: [A1, A2],
          status: TopologyAppStatus.ERROR,
        },
      ] as never,
      apps,
      projects: [
        { id: 'p-secret', name: 'Acquisition' },
        { id: 'p-shop', name: 'Shop' },
      ],
      droppedApps: 0,
    }),
    links: [link(null, A1), link(A1, A2), link(B1, A1)],
    clusterLinks: [
      {
        fromClusterId: 'cluster-b',
        toClusterId: 'cluster-a',
        linkCount: 1,
        rps: null,
        viaTunnel: true,
      },
    ],
  };
}

function make(opts: { readable: string[]; sections: string[] }) {
  const policy = {
    resolveAccess: jest.fn(async () => ({})),
    sectionAccessFrom: jest.fn(() =>
      opts.sections.map((key) => ({ key, level: 'full' })),
    ),
  };
  const access = {
    filterReadable: jest.fn(async (_u: unknown, apps: { id: string }[]) =>
      apps.filter((a) => opts.readable.includes(a.id)),
    ),
  };
  const repo = {
    find: jest.fn(async ({ where }: { where: { id: { value: string[] } } }) =>
      where.id.value.map((id) => ({ id })),
    ),
  };
  const service = new TopologyScopeService(
    policy as never,
    access as never,
    repo as never,
  );
  return { service, policy, access };
}

const person: AuthenticatedUser = { userId: 'u1' } as AuthenticatedUser;

function withPlatform(): TopologyResponseDto {
  const t = topology();
  const grafana = {
    ...app('44444444-4444-4444-8444-444444444444', 'cluster-a'),
    kind: 'system',
  } as TopologyAppDto;
  const loose = {
    ...app('flui-control/alertmanager', 'cluster-a'),
    kind: 'system',
  } as TopologyAppDto;
  return { ...t, apps: [...t.apps, grafana, loose] };
}

describe('TopologyScopeService platform apps', () => {
  const GRAFANA = '44444444-4444-4444-8444-444444444444';

  it('leaves them out unless asked, even when the caller could read them', async () => {
    const { service } = make({
      readable: [A1, GRAFANA],
      sections: ['clusters'],
    });
    const view = await service.scope(person, withPlatform());
    expect(view.apps.map((a) => a.id)).toEqual([A1]);
  });

  it('shows them on request to whoever sees every cluster, record or not', async () => {
    const { service } = make({ readable: [A1], sections: ['clusters'] });
    const view = await service.scope(person, withPlatform(), true);
    expect(view.apps.map((a) => a.id)).toEqual([
      A1,
      GRAFANA,
      'flui-control/alertmanager',
    ]);
  });

  it('never shows them to someone without the clusters section, asked or not', async () => {
    const { service } = make({
      readable: [A1, GRAFANA],
      sections: ['workloads'],
    });
    const view = await service.scope(person, withPlatform(), true);
    expect(view.apps.map((a) => a.id)).toEqual([A1]);
  });
});

describe('TopologyScopeService snapshot', () => {
  it('shows every cluster to the clusters section, still narrowing the apps', async () => {
    const { service } = make({ readable: [A1, B1], sections: ['clusters'] });
    const view = await service.scope(person, topology());
    expect(view.clusters.map((c) => c.id)).toEqual(['cluster-a', 'cluster-b']);
    expect(view.apps.map((a) => a.id)).toEqual([A1, B1]);
    expect(view.stats.errorCount).toBe(0);
  });

  it('counts per cluster only what the caller sees', async () => {
    const { service } = make({ readable: [A1], sections: ['clusters'] });
    const view = await service.scope(person, topology());
    expect(view.clusters[0].counts).toMatchObject({ apps: 1, errors: 0 });
    expect(view.clusters[1].counts.apps).toBe(0);
  });

  it('narrows a stack to its readable apps, moving the primary if it is hidden', async () => {
    const { service } = make({ readable: [A1], sections: ['workloads'] });
    const view = await service.scope(person, topology());
    expect(view.stacks).toEqual([
      expect.objectContaining({
        appIds: [A1],
        primaryAppId: A1,
        status: TopologyAppStatus.RUNNING,
      }),
    ]);
  });

  it('names only the projects of the apps the caller reads', async () => {
    const { service } = make({ readable: [A1], sections: ['workloads'] });
    const view = await service.scope(person, topology());
    expect(view.projects).toEqual([{ id: 'p-shop', name: 'Shop' }]);
  });

  it('shows someone without the section only the clusters hosting apps they read', async () => {
    const { service } = make({ readable: [B1], sections: ['workloads'] });
    const view = await service.scope(person, topology());
    expect(view.clusters.map((c) => c.id)).toEqual(['cluster-b']);
    expect(view.servers.map((s) => s.id)).toEqual(['node-b']);
    expect(view.stats).toMatchObject({ totalClusters: 1, totalServers: 1 });
  });

  it('keeps only the links whose apps are all readable', async () => {
    const { service } = make({ readable: [A1, B1], sections: ['workloads'] });
    const view = await service.scope(person, topology());
    expect(view.links.map((l) => l.id)).toEqual([
      'null->' + A1,
      `${B1}->${A1}`,
    ]);
    expect(view.clusterLinks).toHaveLength(1);
  });

  it('shows nothing to someone who reads no app', async () => {
    const { service } = make({ readable: [], sections: ['workloads'] });
    const view = await service.scope(person, topology());
    expect(view.clusters).toEqual([]);
    expect(view.servers).toEqual([]);
    expect(view.links).toEqual([]);
  });

  it('never opens every cluster to a key limited to some applications', async () => {
    const { service, policy } = make({
      readable: [A1],
      sections: ['clusters'],
    });
    const key = { userId: 'u1', applicationIds: [A1] } as AuthenticatedUser;
    const view = await service.scope(key, topology());
    expect(view.clusters.map((c) => c.id)).toEqual(['cluster-a']);
    expect(policy.resolveAccess).not.toHaveBeenCalled();
  });

  it('never opens every cluster to an agent key without cluster:read', async () => {
    const { service } = make({ readable: [A1], sections: ['clusters'] });
    const agent = { userId: 'u1', scopes: ['mcp:deploy'] } as AuthenticatedUser;
    const view = await service.scope(agent, topology());
    expect(view.clusters.map((c) => c.id)).toEqual(['cluster-a']);
  });

  it('asks the database only for application ids', async () => {
    const { service, access } = make({ readable: [], sections: [] });
    const t = topology();
    t.apps.push(app('not-a-uuid', 'cluster-a'));
    await service.scope(person, t);
    const asked = (access.filterReadable.mock.calls[0][1] as { id: string }[])
      .map((a) => a.id)
      .sort();
    expect(asked).toEqual([A1, A2, B1].sort());
  });
});

describe('scopeChange', () => {
  const scope = {
    everyCluster: false,
    clusterIds: new Set(['cluster-a']),
    appIds: new Set([A1]),
  };
  const change = (
    event: TopologyEventType,
    data: TopologyChange['data'],
  ): TopologyChange => ({ event, data });

  it.each([
    [TopologyEventType.HEARTBEAT, { ts: 'now' }, true],
    [TopologyEventType.APP_DEPLOYED, { app: { id: A1 } }, true],
    [TopologyEventType.APP_DEPLOYED, { app: { id: B1 } }, false],
    [TopologyEventType.APP_STATUS_CHANGED, { appId: A1 }, true],
    [TopologyEventType.APP_SCALED, { appId: B1 }, false],
    [TopologyEventType.APP_REMOVED, { appId: B1 }, false],
    [TopologyEventType.SERVER_ADDED, { clusterId: 'cluster-a' }, true],
    [TopologyEventType.SERVER_REMOVED, { clusterId: 'cluster-b' }, false],
    [TopologyEventType.APP_SCALED, {}, false],
  ])('%s %j → %s', (event, data, visible) => {
    expect(scopeChange(change(event, data as never), scope) !== null).toBe(
      visible,
    );
  });

  it('keeps only the capacity of servers in visible clusters', () => {
    const out = scopeChange(
      change(TopologyEventType.SERVER_CAPACITY, {
        capacities: [
          { serverId: 'a', clusterId: 'cluster-a' },
          { serverId: 'b', clusterId: 'cluster-b' },
        ] as never,
      }),
      scope,
    );
    expect(out?.data.capacities?.map((c) => c.serverId)).toEqual(['a']);
  });

  it('drops a capacity change that concerns no visible cluster', () => {
    const out = scopeChange(
      change(TopologyEventType.SERVER_CAPACITY, {
        capacities: [{ serverId: 'b', clusterId: 'cluster-b' }] as never,
      }),
      scope,
    );
    expect(out).toBeNull();
  });

  it('narrows a links change to the readable apps', () => {
    const out = scopeChange(
      change(TopologyEventType.LINKS_CHANGED, {
        links: [link(null, A1), link(A1, B1)],
        clusterLinks: [],
      }),
      scope,
    );
    expect(out?.data.links?.map((l) => l.id)).toEqual(['null->' + A1]);
  });
});

describe('TopologyScopeService stream', () => {
  it('relays a removal of an app the subscriber could read before it left the snapshot', async () => {
    const { service } = make({ readable: [A1, B1], sections: [] });
    const before = topology();
    const after = {
      ...before,
      apps: before.apps.filter((a) => a.id === B1),
    };
    let current = before;
    const changes = new Subject<TopologyChange>();
    const out = firstValueFrom(
      service
        .scopeStream(person, changes, async () => current)
        .pipe(take(3), toArray()),
    );

    changes.next({ event: TopologyEventType.APP_SCALED, data: { appId: A1 } });
    await new Promise((r) => setImmediate(r));
    current = after;
    changes.next({ event: TopologyEventType.APP_SCALED, data: { appId: A2 } });
    changes.next({ event: TopologyEventType.APP_REMOVED, data: { appId: A1 } });
    changes.next({ event: TopologyEventType.APP_SCALED, data: { appId: B1 } });

    const seen = await out;
    expect(seen.map((c) => [c.event, c.data.appId])).toEqual([
      [TopologyEventType.APP_SCALED, A1],
      [TopologyEventType.APP_REMOVED, A1],
      [TopologyEventType.APP_SCALED, B1],
    ]);
  });

  it('stops relaying an app once access to it is gone', async () => {
    const readable = [A1];
    const { service } = make({ readable, sections: [] });
    let current = topology();
    const changes = new Subject<TopologyChange>();
    const out = firstValueFrom(
      service
        .scopeStream(person, changes, async () => current)
        .pipe(take(2), toArray()),
    );

    changes.next({ event: TopologyEventType.APP_SCALED, data: { appId: A1 } });
    await new Promise((r) => setImmediate(r));
    readable.splice(0, 1, B1);
    current = topology();
    changes.next({ event: TopologyEventType.APP_SCALED, data: { appId: A1 } });
    changes.next({ event: TopologyEventType.APP_SCALED, data: { appId: B1 } });

    const seen = await out;
    expect(seen.map((c) => c.data.appId)).toEqual([A1, B1]);
  });
});
