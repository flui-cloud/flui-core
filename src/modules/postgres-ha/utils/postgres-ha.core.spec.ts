import {
  renderCnpgCluster,
  renderCnpgCredentials,
  CnpgClusterInput,
} from './cnpg-cluster.core';
import {
  haCandidatesFrom,
  postgresHaFeasibility,
} from './postgres-ha-feasibility.core';
import { HaTopology } from '../../providers/core/ha-topology';

const hetzner: HaTopology = {
  region: 'eu-central',
  zones: ['fsn1', 'nbg1', 'hel1'],
  dataZones: ['fsn1', 'nbg1'],
  validated: true,
  measured: true,
};

const base: CnpgClusterInput = {
  name: 'orders-db',
  namespace: 'flui-app-orders',
  appId: 'app-1',
  instances: 3,
  preferredZones: ['fsn1', 'nbg1'],
  durability: 'required',
  storageClass: 'flui-local',
  sizeGi: 10,
  database: 'orders',
  owner: 'orders',
  credentialsSecret: 'orders-db-credentials',
};

describe('the highly available Postgres Flui asks the operator for', () => {
  it('keeps one instance in each location, the primary in a close one', () => {
    const spec = renderCnpgCluster(base).spec as Record<string, any>;
    expect(spec.instances).toBe(3);
    expect(spec.affinity).toEqual({
      enablePodAntiAffinity: true,
      podAntiAffinityType: 'required',
      topologyKey: 'topology.kubernetes.io/zone',
      nodeAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          {
            weight: 100,
            preference: {
              matchExpressions: [
                {
                  key: 'topology.kubernetes.io/zone',
                  operator: 'In',
                  values: ['fsn1', 'nbg1'],
                },
              ],
            },
          },
        ],
      },
    });
    expect(spec.storage).toEqual({ storageClass: 'flui-local', size: '10Gi' });
  });

  /** The operator's default is a newer major that cannot start on a copy of Flui's Postgres. */
  it("pins the image to the major of Flui's own Postgres unless told otherwise", () => {
    expect(
      (renderCnpgCluster(base).spec as Record<string, any>).imageName,
    ).toBe('ghcr.io/cloudnative-pg/postgresql:17.11-standard-trixie');
    expect(
      (
        renderCnpgCluster({ ...base, imageName: 'registry/pg:17.12' })
          .spec as Record<string, any>
      ).imageName,
    ).toBe('registry/pg:17.12');
  });

  it('confirms a write once one copy has it, and says what happens without one', () => {
    expect(
      (renderCnpgCluster(base).spec as Record<string, any>).postgresql,
    ).toEqual({
      synchronous: {
        method: 'any',
        number: 1,
        dataDurability: 'required',
        failoverQuorum: true,
      },
    });
    expect(
      (
        renderCnpgCluster({ ...base, durability: 'preferred' }).spec as Record<
          string,
          any
        >
      ).postgresql.synchronous.dataDurability,
    ).toBe('preferred');
  });

  /** The labels every Flui feature already uses to find an application's database. */
  it('carries the application and engine labels onto every instance', () => {
    const cluster = renderCnpgCluster(base);
    const labels = {
      'flui-app-id': 'app-1',
      'flui.cloud/db-engine': 'postgres',
      'flui.cloud/managed-by': 'flui-cloud',
    };
    expect((cluster.metadata as Record<string, any>).labels).toEqual(labels);
    expect(
      (cluster.spec as Record<string, any>).inheritedMetadata.labels,
    ).toEqual(labels);
  });

  /** What the copy-behind and copy-missing alerts read. */
  it("has every instance's replication figures collected", () => {
    expect(
      (renderCnpgCluster(base).spec as Record<string, any>).inheritedMetadata
        .annotations,
    ).toEqual({
      'prometheus.io/scrape': 'true',
      'prometheus.io/port': '9187',
      'prometheus.io/path': '/metrics',
    });
  });

  it('creates the database and its owner from the credentials Flui generated', () => {
    expect(
      (renderCnpgCluster(base).spec as Record<string, any>).bootstrap,
    ).toEqual({
      initdb: {
        database: 'orders',
        owner: 'orders',
        secret: { name: 'orders-db-credentials' },
      },
    });
  });

  it('refuses one instance', () => {
    expect(() => renderCnpgCluster({ ...base, instances: 1 })).toThrow(
      /at least two/,
    );
  });
});

describe('whether a cluster can hold a highly available Postgres', () => {
  const lab = [
    { name: 'master', zone: 'fsn1', schedulable: true },
    { name: 'worker-1', zone: 'nbg1', schedulable: true },
    { name: 'worker-2', zone: 'fsn1', schedulable: true },
    { name: 'worker-3', zone: 'hel1', schedulable: true },
  ];

  it('needs a node that takes workloads in each of the three locations', () => {
    expect(postgresHaFeasibility(lab, hetzner)).toEqual({ feasible: true });
  });

  it('names the locations that have none', () => {
    expect(postgresHaFeasibility(lab.slice(0, 3), hetzner)).toMatchObject({
      feasible: false,
      reason: expect.stringContaining('hel1 has no node'),
    });
    expect(
      postgresHaFeasibility(
        [
          ...lab.slice(0, 3),
          { name: 'worker-3', zone: 'hel1', schedulable: false },
        ],
        hetzner,
      ),
    ).toMatchObject({ feasible: false });
  });
});

describe('the owner credentials the operator reads', () => {
  it('is a basic-auth secret labelled with its application', () => {
    expect(
      renderCnpgCredentials({
        name: 'orders-db-credentials',
        namespace: 'flui-app-orders',
        appId: 'app-1',
        username: 'orders',
        password: 'secret-value',
      }),
    ).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'kubernetes.io/basic-auth',
      metadata: {
        name: 'orders-db-credentials',
        namespace: 'flui-app-orders',
        labels: {
          'flui-app-id': 'app-1',
          'flui.cloud/managed-by': 'flui-cloud',
        },
      },
      stringData: { username: 'orders', password: 'secret-value' },
    });
  });
});

describe('which nodes can hold an instance', () => {
  const node = (
    name: string,
    zone: string | undefined,
    extra: Record<string, unknown> = {},
  ) => ({
    metadata: {
      name,
      labels: zone ? { 'topology.kubernetes.io/zone': zone } : {},
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
    ...extra,
  });

  it('reads the location label and leaves out cordoned, tainted and unready nodes', () => {
    expect(
      haCandidatesFrom([
        node('a', 'fsn1'),
        node('b', 'fsn1', { spec: { unschedulable: true } }),
        node('c', 'nbg1', {
          spec: {
            taints: [
              {
                key: 'node-role.kubernetes.io/control-plane',
                effect: 'NoSchedule',
              },
            ],
          },
        }),
        node('d', 'hel1', {
          status: { conditions: [{ type: 'Ready', status: 'False' }] },
        }),
        node('e', undefined),
      ]),
    ).toEqual([
      { name: 'a', zone: 'fsn1', schedulable: true },
      { name: 'b', zone: 'fsn1', schedulable: false },
      { name: 'c', zone: 'nbg1', schedulable: false },
      { name: 'd', zone: 'hel1', schedulable: false },
      { name: 'e', zone: undefined, schedulable: true },
    ]);
  });
});
