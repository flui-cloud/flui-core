import { ClusterBoundsRegistry } from './cluster-bounds.registry';

describe('ClusterBoundsRegistry', () => {
  it('answers with nothing until something owns a cluster, so the cluster row keeps the fence', async () => {
    const registry = new ClusterBoundsRegistry();
    await expect(registry.boundsFor('c-1')).resolves.toBeNull();
  });

  it('hands back the owner bounds once one is registered', async () => {
    const registry = new ClusterBoundsRegistry();
    registry.register({
      name: 'groups',
      boundsFor: async () => ({ min: 1, max: 4 }),
    });
    await expect(registry.boundsFor('c-1')).resolves.toEqual({
      min: 1,
      max: 4,
    });
  });

  it('keeps the cluster fence for a cluster its source knows nothing about', async () => {
    const registry = new ClusterBoundsRegistry();
    registry.register({
      name: 'groups',
      boundsFor: async (clusterId) =>
        clusterId === 'c-1' ? { min: 2, max: 5 } : null,
    });
    await expect(registry.boundsFor('c-2')).resolves.toBeNull();
  });

  it('passes over a source that cannot answer rather than reporting no limits', async () => {
    const registry = new ClusterBoundsRegistry();
    registry.register({
      name: 'broken',
      boundsFor: async () => {
        throw new Error('database is away');
      },
    });
    registry.register({
      name: 'groups',
      boundsFor: async () => ({ min: 1, max: 3 }),
    });
    await expect(registry.boundsFor('c-1')).resolves.toEqual({
      min: 1,
      max: 3,
    });
  });

  it('reports whether anyone took bounds written through the older route', async () => {
    const registry = new ClusterBoundsRegistry();
    const taken: unknown[] = [];
    registry.register({
      name: 'groups',
      boundsFor: async () => null,
      writeBounds: async (_clusterId, bounds) => {
        taken.push(bounds);
        return true;
      },
    });

    await expect(registry.writeBounds('c-1', { min: 1, max: 6 })).resolves.toBe(
      true,
    );
    expect(taken).toEqual([{ min: 1, max: 6 }]);
  });

  it('says nobody took them when no source owns the cluster', async () => {
    const registry = new ClusterBoundsRegistry();
    registry.register({ name: 'groups', boundsFor: async () => null });
    await expect(registry.writeBounds('c-1', { min: 1, max: 6 })).resolves.toBe(
      false,
    );
  });

  it('surfaces a failed write rather than letting the number look stored', async () => {
    const registry = new ClusterBoundsRegistry();
    registry.register({
      name: 'groups',
      boundsFor: async () => null,
      writeBounds: async () => {
        throw new Error('write refused');
      },
    });
    await expect(
      registry.writeBounds('c-1', { min: 1, max: 6 }),
    ).rejects.toThrow('write refused');
  });
});
