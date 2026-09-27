jest.mock('@kubernetes/client-node', () => ({}));

import { StatefulSetVolumeSwapService } from './statefulset-volume-swap.service';

/**
 * A cluster that behaves like one for claims and volumes: a deleted claim
 * leaves its volume Released with the old claimRef, a claim naming a volume
 * binds only when that volume is Available, and a pod exists while the set
 * has a replica.
 */
class FakeCluster {
  objects = new Map<string, any>();
  key = (kind: string, name: string, ns?: string) =>
    `${kind}|${ns ?? ''}|${name}`;

  constructor() {
    this.put('StatefulSet', 'pg', 'db', {
      spec: {
        replicas: 1,
        volumeClaimTemplates: [{ metadata: { name: 'data' } }],
      },
    });
    this.put('Pod', 'pg-0', 'db', {});
    this.pv('pv-live', 'data-pg-0');
    this.pv('pv-copy', 'data-pg-0-restored-1');
    this.pvc('data-pg-0', 'pv-live', { app: 'pg' });
    this.pvc('data-pg-0-restored-1', 'pv-copy', {});
  }

  put(kind: string, name: string, ns: string | undefined, body: any) {
    this.objects.set(this.key(kind, name, ns), {
      ...body,
      kind,
      metadata: {
        ...(body.metadata ?? {}),
        name,
        ...(ns ? { namespace: ns } : {}),
      },
    });
  }
  pv(name: string, claim: string) {
    this.put('PersistentVolume', name, undefined, {
      spec: {
        persistentVolumeReclaimPolicy: 'Delete',
        claimRef: { name: claim, namespace: 'db' },
        capacity: { storage: '5Gi' },
      },
      status: { phase: 'Bound' },
    });
  }
  pvc(name: string, pv: string, labels: Record<string, string>) {
    this.put('PersistentVolumeClaim', name, 'db', {
      metadata: { labels },
      spec: {
        volumeName: pv,
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
      },
      status: { phase: 'Bound' },
    });
  }
  get(kind: string, name: string, ns?: string) {
    return this.objects.get(this.key(kind, name, ns)) ?? null;
  }

  readObject = jest.fn(
    async (_kc: string, _v: string, kind: string, name: string, ns?: string) =>
      this.get(kind, name, ns),
  );
  mergePatchObject = jest.fn(async (_kc: string, patch: any) => {
    const obj = this.get(
      patch.kind,
      patch.metadata.name,
      patch.metadata.namespace,
    );
    for (const [k, v] of Object.entries(patch.spec ?? {})) {
      if (v === null) delete obj.spec[k];
      else obj.spec[k] = v;
    }
    if (patch.kind === 'PersistentVolume' && patch.spec?.claimRef === null) {
      obj.status.phase = 'Available';
    }
  });
  deleteResource = jest.fn(
    async (_kc: string, kind: string, name: string, ns: string) => {
      const claim = this.get(kind, name, ns);
      this.objects.delete(this.key(kind, name, ns));
      const pv = this.get('PersistentVolume', claim.spec.volumeName);
      if (pv.spec.persistentVolumeReclaimPolicy === 'Delete') {
        this.objects.delete(this.key('PersistentVolume', pv.metadata.name));
      } else {
        pv.status.phase = 'Released';
      }
    },
  );
  createObject = jest.fn(async (_kc: string, obj: any) => {
    const pv = this.get('PersistentVolume', obj.spec.volumeName);
    if (pv?.status.phase !== 'Available')
      throw new Error(`${obj.spec.volumeName} is not available`);
    pv.spec.claimRef = {
      name: obj.metadata.name,
      namespace: obj.metadata.namespace,
    };
    pv.status.phase = 'Bound';
    this.put(
      'PersistentVolumeClaim',
      obj.metadata.name,
      obj.metadata.namespace,
      {
        ...obj,
        status: { phase: 'Bound' },
      },
    );
  });
  scaleWorkload = jest.fn(
    async (_kc: string, _k: string, ns: string, name: string, n: number) => {
      this.get('StatefulSet', name, ns).spec.replicas = n;
      if (n === 0) this.objects.delete(this.key('Pod', `${name}-0`, ns));
      else this.put('Pod', `${name}-0`, ns, {});
    },
  );
}

describe('StatefulSetVolumeSwapService', () => {
  const input = {
    kubeconfig: 'kc',
    namespace: 'db',
    statefulSet: 'pg',
    volumeName: 'data',
    restoredClaim: 'data-pg-0-restored-1',
    appId: 'app-1',
    now: new Date('2026-09-27T10:00:00Z'),
  };

  it('puts the restored data under the claim the database uses and keeps the old data', async () => {
    const cluster = new FakeCluster();
    const result = await new StatefulSetVolumeSwapService(
      cluster as never,
    ).swap(input);

    expect(
      cluster.get('PersistentVolumeClaim', 'data-pg-0', 'db').spec.volumeName,
    ).toBe('pv-copy');
    expect(
      cluster.get('PersistentVolumeClaim', result.previousClaim, 'db').spec
        .volumeName,
    ).toBe('pv-live');
    expect(
      cluster.get('PersistentVolumeClaim', result.previousClaim, 'db').metadata
        .labels,
    ).toMatchObject({
      'flui.cloud/previous-volume': 'true',
      'flui-app-id': 'app-1',
    });
    expect(
      cluster.get('PersistentVolumeClaim', 'data-pg-0-restored-1', 'db'),
    ).toBeNull();
    expect(cluster.get('StatefulSet', 'pg', 'db').spec.replicas).toBe(1);
    expect(
      cluster.get('PersistentVolume', 'pv-copy').spec
        .persistentVolumeReclaimPolicy,
    ).toBe('Delete');
  });

  it('names the volumes it has when asked for one it does not', async () => {
    const cluster = new FakeCluster();
    await expect(
      new StatefulSetVolumeSwapService(cluster as never).swap({
        ...input,
        volumeName: 'pgdata',
      }),
    ).rejects.toThrow('"data"');
    expect(cluster.scaleWorkload).not.toHaveBeenCalled();
  });

  it('leaves the database on its own data when binding the copy fails', async () => {
    const cluster = new FakeCluster();
    const create = cluster.createObject.getMockImplementation()!;
    cluster.createObject.mockImplementationOnce(async () => {
      throw new Error('admission refused');
    });
    cluster.createObject.mockImplementation(create);
    await expect(
      new StatefulSetVolumeSwapService(cluster as never).swap(input),
    ).rejects.toThrow('admission refused');

    expect(
      cluster.get('PersistentVolumeClaim', 'data-pg-0', 'db').spec.volumeName,
    ).toBe('pv-live');
    expect(cluster.get('StatefulSet', 'pg', 'db').spec.replicas).toBe(1);
  });
});
