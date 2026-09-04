/**
 * The lease exists so that a backup can never leave an application down. These
 * tests are about the ways that promise breaks, not the happy path.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import {
  PAUSED_AT_ANNOTATION,
  PAUSED_LABEL,
  PAUSED_REPLICAS_ANNOTATION,
  PAUSE_LEASE_TTL_MS,
  VolumePauseLeaseService,
} from './volume-pause-lease.service';

describe('VolumePauseLeaseService', () => {
  function make(overrides: Partial<Record<string, any>> = {}) {
    const k8s: any = {
      findPodsMountingPvcDetailed: jest.fn(async () => []),
      findPodsMountingPvc: jest.fn(async () => []),
      findWorkloadsMountingPvc: jest.fn(async () => []),
      annotateAndLabelWorkload: jest.fn(async () => {}),
      scaleWorkload: jest.fn(async () => {}),
      listResourcesByLabelEverywhere: jest.fn(async () => []),
      getResource: jest.fn(async () => null),
      ...overrides,
    };
    return { service: new VolumePauseLeaseService(k8s), k8s };
  }

  describe('acquire', () => {
    it('refuses when a holder is on a node that cannot be reached', async () => {
      const { service, k8s } = make({
        findPodsMountingPvcDetailed: async () => [
          { name: 'pg-0', phase: 'Unknown', ownerRootName: 'pg' },
        ],
      });

      // Scaling to zero cannot stop a process the kubelet cannot reach, so the
      // copy would be taken live while the ledger claimed `writers-stopped`.
      await expect(service.acquire('kc', 'ns', 'data-pg-0')).rejects.toThrow(
        /cannot be reached/,
      );
      expect(k8s.scaleWorkload).not.toHaveBeenCalled();
    });

    it('refuses when a holder belongs to something it cannot scale', async () => {
      const { service, k8s } = make({
        findPodsMountingPvcDetailed: async () => [
          { name: 'pg-0', phase: 'Running', ownerRootName: 'pg' },
          {
            name: 'importer',
            phase: 'Running',
            ownerRootKind: 'Job',
            ownerRootName: 'importer',
          },
        ],
        findWorkloadsMountingPvc: async () => [
          { kind: 'StatefulSet', name: 'pg', replicas: 1 },
        ],
      });

      // Pausing the StatefulSet alone would report a quiet volume while the Job
      // kept writing to it.
      await expect(service.acquire('kc', 'ns', 'data-pg-0')).rejects.toThrow(
        /not something Flui can scale down/,
      );
      expect(k8s.scaleWorkload).not.toHaveBeenCalled();
    });

    it('records the replica count before scaling, never after', async () => {
      const calls: string[] = [];
      const { service } = make({
        findPodsMountingPvcDetailed: async () => [
          { name: 'pg-0', phase: 'Running', ownerRootName: 'pg' },
        ],
        findWorkloadsMountingPvc: async () => [
          { kind: 'StatefulSet', name: 'pg', replicas: 3 },
        ],
        annotateAndLabelWorkload: async (
          _kc: string,
          _k: string,
          _ns: string,
          _n: string,
          _labels: any,
          annotations: any,
        ) => {
          calls.push(`annotate:${annotations[PAUSED_REPLICAS_ANNOTATION]}`);
        },
        scaleWorkload: async () => {
          calls.push('scale');
        },
      });

      const paused = await service.acquire('kc', 'ns', 'data-pg-0');

      // The order is the guarantee: if the process dies between the two, the
      // workload is still running and the annotation is merely stale.
      expect(calls).toEqual(['annotate:3', 'scale']);
      expect(paused).toEqual([
        { kind: 'StatefulSet', name: 'pg', replicas: 3, namespace: 'ns' },
      ]);
    });
  });

  describe('release', () => {
    it('restores the recorded count and clears the lease', async () => {
      const { service, k8s } = make({
        getResource: async () => ({
          metadata: { annotations: { [PAUSED_REPLICAS_ANNOTATION]: '3' } },
          spec: { replicas: 0 },
        }),
      });

      await service.release('kc', [
        { kind: 'StatefulSet', name: 'pg', namespace: 'ns', replicas: 0 },
      ]);

      expect(k8s.scaleWorkload).toHaveBeenCalledWith(
        'kc',
        'StatefulSet',
        'ns',
        'pg',
        3,
      );
      expect(k8s.annotateAndLabelWorkload).toHaveBeenCalledWith(
        'kc',
        'StatefulSet',
        'ns',
        'pg',
        { [PAUSED_LABEL]: null },
        {
          [PAUSED_REPLICAS_ANNOTATION]: null,
          [PAUSED_AT_ANNOTATION]: null,
        },
      );
    });

    it('leaves alone a workload nothing paused', async () => {
      const { service, k8s } = make({
        getResource: async () => ({ metadata: {}, spec: { replicas: 0 } }),
      });

      await service.release('kc', [
        { kind: 'Deployment', name: 'web', namespace: 'ns', replicas: 0 },
      ]);

      expect(k8s.scaleWorkload).not.toHaveBeenCalled();
    });

    it('does not re-scale a workload someone already started', async () => {
      const { service, k8s } = make({
        getResource: async () => ({
          metadata: { annotations: { [PAUSED_REPLICAS_ANNOTATION]: '3' } },
          spec: { replicas: 5 },
        }),
      });

      await service.release('kc', [
        { kind: 'StatefulSet', name: 'pg', namespace: 'ns', replicas: 0 },
      ]);

      expect(k8s.scaleWorkload).not.toHaveBeenCalled();
      // The stale lease is still cleared, or every sweep would keep finding it.
      expect(k8s.annotateAndLabelWorkload).toHaveBeenCalled();
    });

    it('keeps going when one workload cannot be restored', async () => {
      const { service, k8s } = make({
        getResource: jest
          .fn()
          .mockRejectedValueOnce(new Error('gone'))
          .mockResolvedValue({
            metadata: { annotations: { [PAUSED_REPLICAS_ANNOTATION]: '2' } },
            spec: { replicas: 0 },
          }),
      });

      await service.release('kc', [
        { kind: 'StatefulSet', name: 'broken', namespace: 'ns', replicas: 0 },
        { kind: 'Deployment', name: 'web', namespace: 'ns', replicas: 0 },
      ]);

      expect(k8s.scaleWorkload).toHaveBeenCalledWith(
        'kc',
        'Deployment',
        'ns',
        'web',
        2,
      );
    });
  });

  describe('sweep', () => {
    const leased = (agoMs: number) => ({
      metadata: {
        name: 'pg',
        namespace: 'ns',
        annotations: {
          [PAUSED_AT_ANNOTATION]: new Date(Date.now() - agoMs).toISOString(),
          [PAUSED_REPLICAS_ANNOTATION]: '1',
        },
      },
      spec: { replicas: 0 },
    });

    it('leaves a fresh lease alone — a copy may still be running', async () => {
      const { service, k8s } = make({
        listResourcesByLabelEverywhere: async (_kc: string, kind: string) =>
          kind === 'StatefulSet' ? [leased(60_000)] : [],
      });

      expect(await service.sweep('kc')).toBe(0);
      expect(k8s.scaleWorkload).not.toHaveBeenCalled();
    });

    it('releases a lease past its TTL whatever the copy believes', async () => {
      const { service } = make({
        listResourcesByLabelEverywhere: async (_kc: string, kind: string) =>
          kind === 'StatefulSet' ? [leased(PAUSE_LEASE_TTL_MS + 1000)] : [],
        getResource: async () => leased(PAUSE_LEASE_TTL_MS + 1000),
      });

      expect(await service.sweep('kc')).toBe(1);
    });

    it('releases every lease when forced, as at boot', async () => {
      const { service } = make({
        listResourcesByLabelEverywhere: async (_kc: string, kind: string) =>
          kind === 'Deployment' ? [leased(1000)] : [],
        getResource: async () => leased(1000),
      });

      // At boot any lease belongs to a copy that died with the last process.
      expect(await service.sweep('kc', true)).toBe(1);
    });

    it('treats an unparseable timestamp as expired', async () => {
      const broken = {
        metadata: {
          name: 'pg',
          namespace: 'ns',
          annotations: {
            [PAUSED_AT_ANNOTATION]: 'not-a-date',
            [PAUSED_REPLICAS_ANNOTATION]: '1',
          },
        },
        spec: { replicas: 0 },
      };
      const { service } = make({
        listResourcesByLabelEverywhere: async (_kc: string, kind: string) =>
          kind === 'StatefulSet' ? [broken] : [],
        getResource: async () => broken,
      });

      // Erring towards releasing: the cost is an application started early,
      // against an application that stays down forever.
      expect(await service.sweep('kc')).toBe(1);
    });
  });
});
