jest.mock('@kubernetes/client-node', () => ({}));

import {
  VELERO_KINDS,
  VELERO_NAMESPACE,
  VeleroUninstallService,
} from './velero-uninstall.service';
import {
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';
import { BACKUP_JOB_TYPES } from '../backups.constants';

type Obj = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    finalizers?: string[];
  };
};

/** A cluster as a list of objects, and the calls made against it. */
function fakeCluster(objects: Obj[]) {
  const store = [...objects];
  const key = (kind: string, name: string, ns?: string) =>
    `${kind}/${ns ?? ''}/${name}`;
  const find = (kind: string, name: string, ns?: string) =>
    store.find(
      (o) =>
        key(o.kind, o.metadata.name, o.metadata.namespace) ===
        key(kind, name, ns),
    );
  const deleted: string[] = [];
  const patched: string[] = [];
  const k8s = {
    readObject: jest.fn(
      async (
        _kc: string,
        _v: string,
        kind: string,
        name: string,
        ns?: string,
      ) => find(kind, name, ns) ?? null,
    ),
    deleteObject: jest.fn(
      async (
        _kc: string,
        _v: string,
        kind: string,
        name: string,
        ns?: string,
      ) => {
        const o = find(kind, name, ns);
        if (o?.metadata.finalizers?.length) {
          throw new Error(`${kind}/${name} still has finalizers`);
        }
        if (o) store.splice(store.indexOf(o), 1);
        deleted.push(key(kind, name, ns));
      },
    ),
    mergePatchObject: jest.fn(async (_kc: string, patch: Obj) => {
      const o = find(patch.kind, patch.metadata.name, patch.metadata.namespace);
      if (o && patch.metadata.finalizers === null) o.metadata.finalizers = [];
      patched.push(
        key(patch.kind, patch.metadata.name, patch.metadata.namespace),
      );
    }),
    listCrdResources: jest.fn(async (_kc: string, kind: string, ns?: string) =>
      store.filter(
        (o) => o.kind === kind && (!ns || o.metadata.namespace === ns),
      ),
    ),
    deleteNamespace: jest.fn(async (_kc: string, ns: string) => {
      const o = find('Namespace', ns);
      if (o) store.splice(store.indexOf(o), 1);
      deleted.push(key('Namespace', ns));
    }),
  };
  return { k8s, store, deleted, patched };
}

const flui = { 'managed-by': 'flui-cloud' };

function installed(extra: Obj[] = []): Obj[] {
  return [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: VELERO_NAMESPACE, labels: flui },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'velero', namespace: VELERO_NAMESPACE },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'node-agent', namespace: VELERO_NAMESPACE },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'velero-cloud-credentials',
        namespace: VELERO_NAMESPACE,
      },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'velero', labels: flui },
    },
    ...VELERO_KINDS.map((k) => ({
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: `${k.plural}.velero.io` },
    })),
    {
      apiVersion: 'velero.io/v1',
      kind: 'Restore',
      metadata: {
        name: 'flui-restore-1',
        namespace: VELERO_NAMESPACE,
        finalizers: ['restores.velero.io/external-resources-finalizer'],
      },
    },
    {
      apiVersion: 'velero.io/v1',
      kind: 'Backup',
      metadata: { name: 'flui-1', namespace: VELERO_NAMESPACE },
    },
    ...extra,
  ];
}

function build(objects: Obj[], opts: { running?: boolean } = {}) {
  const cluster = fakeCluster(objects);
  const opUpdates: Array<Record<string, any>> = [];
  const ops = {
    findOne: jest.fn(async () => (opts.running ? { id: 'op-running' } : null)),
    create: (o: unknown) => o,
    save: jest.fn(async (o: Record<string, unknown>) => ({ ...o, id: 'op-1' })),
    update: jest.fn(async (_id: string, patch: Record<string, any>) => {
      opUpdates.push(patch);
    }),
  };
  const queue = { add: jest.fn() };
  const service = new VeleroUninstallService(
    cluster.k8s as never,
    { decrypt: () => 'kubeconfig' } as never,
    {
      findOne: async () => ({
        id: 'c1',
        name: 'wc-1',
        status: ClusterStatus.READY,
        kubeconfigEncrypted: 'enc',
      }),
    } as never,
    ops as never,
    {
      find: async () => [{ id: 'p1', name: 'nightly cluster' }],
    } as never,
    { find: async () => [{ id: 'a1' }, { id: 'a2' }] } as never,
    {
      find: async () => [
        {
          artifactId: 'a1',
          destinationId: 'd1',
          objectKeyPrefix: 'velero/backups/flui-1/',
        },
        {
          artifactId: 'a2',
          destinationId: 'd1',
          objectKeyPrefix: 'velero/backups/flui-2/',
        },
      ],
    } as never,
    {
      find: async () => [
        { id: 'd1', name: 'scw', bucket: 'flui-bk', pathPrefix: 'flui/c1/' },
      ],
    } as never,
    queue as never,
    { toCredentials: () => ({}) } as never,
    {
      forProvider: () => ({
        listObjects: async () => ({
          keys: [
            'flui/c1/kopia/flui-control/p0',
            'flui/c1/kopia/flui-control/q1',
            'flui/c1/kopia/0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011/p0',
          ],
          hasMore: false,
        }),
        getUsage: async (_c: unknown, prefix: string) => ({
          bytes: prefix === 'kopia/flui-control/' ? 2048 : 0,
          objectCount: 2,
        }),
      }),
    } as never,
  );
  return { service, cluster, ops, opUpdates, queue };
}

describe('VeleroUninstallService', () => {
  it("names the namespaces' volume data under kopia/, never Flui's own repositories there", async () => {
    const { service } = build(installed());
    const f = await service.inspect('c1');
    expect(f.leftInDestinations[0].volumeData).toEqual([
      { prefix: 'flui/c1/kopia/flui-control/', bytes: 2048 },
    ]);
  });

  it('lists what is installed, the paused policies and where the old backups still are', async () => {
    const { service } = build(installed());
    const f = await service.inspect('c1');
    expect(f).toMatchObject({
      reachable: true,
      installed: true,
      installedByFlui: true,
      namespace: 'present',
      objects: 2,
      objectsElsewhere: 0,
      pausedPolicies: [{ id: 'p1', name: 'nightly cluster' }],
      leftInDestinations: [
        {
          destinationId: 'd1',
          destinationName: 'scw',
          bucket: 'flui-bk',
          prefix: 'flui/c1/velero/',
          backups: 2,
        },
      ],
    });
    expect(f.definitions).toHaveLength(VELERO_KINDS.length);
    expect(f.components.every((c) => c.present)).toBe(true);
  });

  it('starts one operation and hands back the running one on a second start', async () => {
    const first = build(installed());
    await expect(first.service.start('u1', 'c1')).resolves.toEqual({
      operationId: 'op-1',
      alreadyRunning: false,
    });
    expect(first.ops.save).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: OperationType.UNINSTALL_VELERO,
        resourceId: 'c1',
      }),
    );
    expect(first.queue.add).toHaveBeenCalledWith(
      BACKUP_JOB_TYPES.UNINSTALL_VELERO,
      { clusterId: 'c1', operationId: 'op-1' },
      expect.anything(),
    );

    const second = build(installed(), { running: true });
    await expect(second.service.start('u1', 'c1')).resolves.toEqual({
      operationId: 'op-running',
      alreadyRunning: true,
    });
    expect(second.queue.add).not.toHaveBeenCalled();
  });

  it('removes everything it installed, clearing finalizers first, and leaves nothing behind', async () => {
    const { service, cluster, opUpdates } = build(installed());
    await service.run({ clusterId: 'c1', operationId: 'op-1' });
    const last = opUpdates[opUpdates.length - 1];
    expect(last.status).toBe(OperationStatus.COMPLETED);
    expect(cluster.patched).toContain(
      `Restore/${VELERO_NAMESPACE}/flui-restore-1`,
    );
    expect(cluster.store).toEqual([]);
    expect(last.metadata.removed).toEqual(
      expect.arrayContaining([
        'Deployment/velero',
        'DaemonSet/node-agent',
        'Secret/velero-cloud-credentials',
        'ClusterRoleBinding/velero',
        'CustomResourceDefinition/backups.velero.io',
        `Namespace/${VELERO_NAMESPACE}`,
      ]),
    );
    expect(last.metadata.released).toBe(2);
    expect(last.metadata.leftInDestinations).toHaveLength(1);
  });

  it('is a no-op the second time', async () => {
    const { service, opUpdates } = build([]);
    await service.run({ clusterId: 'c1', operationId: 'op-1' });
    const last = opUpdates[opUpdates.length - 1];
    expect(last.status).toBe(OperationStatus.COMPLETED);
    expect(last.metadata.removed).toEqual([]);
  });

  it('touches nothing in a namespace Flui did not create', async () => {
    const objects = installed();
    objects[0].metadata.labels = {};
    const { service, cluster, opUpdates } = build(objects);
    await service.run({ clusterId: 'c1', operationId: 'op-1' });
    expect(opUpdates[opUpdates.length - 1]).toMatchObject({
      status: OperationStatus.FAILED,
    });
    expect(cluster.deleted).toEqual([]);
  });

  it('keeps the definitions and a binding that is not its own when others use them', async () => {
    const objects = installed([
      {
        apiVersion: 'velero.io/v1',
        kind: 'Backup',
        metadata: { name: 'theirs', namespace: 'ops' },
      },
    ]);
    const binding = objects.find((o) => o.kind === 'ClusterRoleBinding')!;
    binding.metadata.labels = {};
    const { service, cluster, opUpdates } = build(objects);
    await service.run({ clusterId: 'c1', operationId: 'op-1' });
    const last = opUpdates[opUpdates.length - 1];
    expect(last.status).toBe(OperationStatus.COMPLETED);
    expect(last.metadata.kept[0]).toContain('1 object(s)');
    expect(
      cluster.store.filter((o) => o.kind === 'CustomResourceDefinition'),
    ).toHaveLength(VELERO_KINDS.length);
    expect(cluster.store).toContainEqual(binding);
    expect(
      cluster.store.find((o) => o.metadata.name === 'theirs'),
    ).toBeTruthy();
  });
});
