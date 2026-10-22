jest.mock('@kubernetes/client-node', () => ({}));

import type * as k8s from '@kubernetes/client-node';
import {
  architectureOf,
  buildAppDto,
  configOf,
  describeStatefulSet,
  listAll,
  mapNodesToServers,
  serverIdFor,
} from './topology-k8s.helper';
import {
  TopologyArchitecture,
  TopologyFluiNetwork,
  TopologyServerRole,
  TopologyWorkloadKind,
} from '../enums/topology.enums';

const CLUSTER = 'c0ffee00-0000-4000-8000-000000000001';
const RECORD = '5e7e7e00-0000-4000-8000-000000000002';

function node(name: string, arch: string, extra: Partial<k8s.V1Node> = {}) {
  return {
    metadata: { name, labels: {} },
    status: {
      nodeInfo: { architecture: arch },
      conditions: [{ type: 'Ready', status: 'True' }],
    },
    spec: {},
    ...extra,
  } as unknown as k8s.V1Node;
}

const ctx = {
  id: CLUSTER,
  provider: 'hetzner',
  records: new Map([
    [
      'prod-eu-master',
      {
        id: RECORD,
        providerResourceId: '48120331',
        serverType: 'cx33',
        region: 'nbg1',
        isMaster: true,
        privateNetwork: true,
        fluiNetwork: TopologyFluiNetwork.ACTIVE,
      },
    ],
  ]),
};

describe('mapNodesToServers', () => {
  const servers = mapNodesToServers(
    [
      node('prod-eu-master', 'amd64'),
      node('edge-pi', 'arm64', {
        spec: { taints: [{ key: 'x', effect: 'NoSchedule' }] },
      } as never),
    ],
    ctx,
  );

  it('joins a node to its server record by name and carries the deep-link fields', () => {
    expect(servers[0]).toMatchObject({
      id: RECORD,
      clusterId: CLUSTER,
      nodeName: 'prod-eu-master',
      provider: 'hetzner',
      providerResourceId: '48120331',
      serverType: 'cx33',
      region: 'nbg1',
      architecture: TopologyArchitecture.X86,
      role: TopologyServerRole.CONTROL_PLANE,
      takesWork: true,
      privateNetwork: true,
      fluiNetwork: TopologyFluiNetwork.ACTIVE,
    });
  });

  it('gives a node without a record an id that does not carry its name, and no deep link', () => {
    expect(servers[1].id).toMatch(/^node:c0ffee00-[0-9a-f-]+:[0-9a-f]{12}$/);
    expect(servers[1].id).not.toContain('edge-pi');
    expect(servers[1]).toMatchObject({
      providerResourceId: null,
      serverType: null,
      region: null,
      architecture: TopologyArchitecture.ARM,
      role: TopologyServerRole.WORKER,
      takesWork: false,
      privateNetwork: false,
      fluiNetwork: TopologyFluiNetwork.NONE,
    });
  });

  it('keeps the synthetic id stable across polls', () => {
    expect(serverIdFor(CLUSTER, 'edge-pi')).toBe(servers[1].id);
  });
});

describe('architectureOf', () => {
  it.each([
    ['amd64', TopologyArchitecture.X86],
    ['arm64', TopologyArchitecture.ARM],
    ['arm', TopologyArchitecture.ARM],
    ['s390x', null],
    ['', null],
  ])('%s → %s', (arch, expected) => {
    expect(architectureOf(node('n', arch))).toBe(expected);
  });
});

describe('buildAppDto', () => {
  it('places replicas on server ids, not node names', () => {
    const servers = mapNodesToServers(
      [node('prod-eu-master', 'amd64'), node('edge-pi', 'arm64')],
      ctx,
    );
    const workload = describeStatefulSet({
      metadata: {
        name: 'postgres',
        namespace: 'shop',
        labels: { 'flui-app-id': 'a1' },
      },
      spec: { replicas: 2, selector: { matchLabels: { app: 'pg' } } },
    } as unknown as k8s.V1StatefulSet);
    const pod = (name: string, on: string) =>
      ({
        metadata: { name, namespace: 'shop', labels: { app: 'pg' } },
        spec: { nodeName: on },
        status: { phase: 'Running', containerStatuses: [{ ready: true }] },
      }) as unknown as k8s.V1Pod;

    const app = buildAppDto(
      workload,
      [pod('postgres-0', 'prod-eu-master'), pod('postgres-1', 'edge-pi')],
      servers,
      CLUSTER,
    );

    expect(app).toMatchObject({
      clusterId: CLUSTER,
      workloadKind: TopologyWorkloadKind.STATEFULSET,
      primaryServerId: RECORD,
      replicaCount: 2,
    });
    expect(app.replicas.map((r) => r.serverId).sort()).toEqual(
      [RECORD, servers[1].id].sort(),
    );
    expect(app).not.toHaveProperty('labels');
  });
});

describe('listAll', () => {
  it('reads a list a page at a time until the server says there is no more', async () => {
    const pages: Record<
      string,
      { items: number[]; metadata: { _continue?: string } }
    > = {
      first: { items: [1, 2], metadata: { _continue: 'b' } },
      b: { items: [3, 4], metadata: { _continue: 'c' } },
      c: { items: [5], metadata: {} },
    };
    const page = jest.fn(async (next?: string) => pages[next ?? 'first']);
    await expect(listAll(page)).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(page.mock.calls.map(([next]) => next)).toEqual([
      undefined,
      'b',
      'c',
    ]);
  });

  it('takes a server that ignores the limit at its word', async () => {
    await expect(listAll(async () => ({ items: ['all'] }))).resolves.toEqual([
      'all',
    ]);
  });
});

describe('configOf', () => {
  it('keeps plain values and config map references, and never anything from a secret', () => {
    const config = configOf({
      spec: {
        initContainers: [
          { name: 'wait', env: [{ name: 'DB_HOST', value: 'postgres' }] },
        ],
        containers: [
          {
            name: 'api',
            env: [
              { name: 'LOG_LEVEL', value: 'info' },
              {
                name: 'DB_PASSWORD',
                valueFrom: { secretKeyRef: { name: 'db', key: 'password' } },
              },
              {
                name: 'LOKI_URL',
                valueFrom: { configMapKeyRef: { name: 'urls', key: 'loki' } },
              },
            ],
            envFrom: [
              { configMapRef: { name: 'flui-api-config' } },
              { secretRef: { name: 'flui-secrets' } },
            ],
          },
        ],
      },
    } as never);
    expect(config).toEqual({
      entries: [
        { key: 'DB_HOST', value: 'postgres' },
        { key: 'LOG_LEVEL', value: 'info' },
      ],
      configMaps: ['flui-api-config'],
      configMapKeys: [{ name: 'urls', key: 'loki', as: 'LOKI_URL' }],
    });
    expect(JSON.stringify(config)).not.toContain('secret');
  });
});
