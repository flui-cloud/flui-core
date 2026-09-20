// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { load } from 'js-yaml';
import {
  WORKLOAD_LIMIT_RANGE_NAME,
  WorkloadNamespaceService,
  buildWorkloadLimitRange,
} from './workload-namespace.service';

describe('the ceiling a workload namespace carries', () => {
  const build = (labels: Record<string, string> | undefined) => {
    const applied: string[] = [];
    const service = new WorkloadNamespaceService({
      ensureNamespaceExists: jest.fn().mockResolvedValue(undefined),
      getResource: jest.fn().mockResolvedValue({ metadata: { labels } }),
      applyManifest: jest.fn(async (_kc: string, yaml: string) => {
        applied.push(yaml);
      }),
    } as never);
    return { service, applied };
  };

  it('gives an ordinary namespace the ceiling', async () => {
    const { service, applied } = build({ 'flui.cloud/tier': 'user' });
    await service.ensure('kc', 'user-alice');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain(WORKLOAD_LIMIT_RANGE_NAME);
  });

  /**
   * The reason this service exists. A sandbox tenancy is dosed by its own
   * LimitRange — 1Gi a container against a quota of 8Gi, tuned so its eight
   * pods fit — and Kubernetes neither merges two LimitRanges nor rejects them:
   * their constraints intersect, but which *default* is injected is not
   * deterministic. So "ours is looser, theirs wins" is not a rule that holds;
   * ours must not be there at all.
   */
  it('leaves a sandbox tenancy to its own', async () => {
    const { service, applied } = build({ 'flui.cloud/sandbox': 'true' });
    await service.ensure('kc', 'user-guest-abc');
    expect(applied).toEqual([]);
  });

  /**
   * Fail towards leaving it alone. A namespace briefly without a ceiling costs
   * one deploy's worth of exposure; a guest tenancy that silently loses its own
   * costs the tenancy.
   */
  it('leaves it alone when the namespace cannot be read', async () => {
    const applied: string[] = [];
    const service = new WorkloadNamespaceService({
      ensureNamespaceExists: jest.fn().mockResolvedValue(undefined),
      getResource: jest.fn().mockRejectedValue(new Error('unreachable')),
      applyManifest: jest.fn(async (_kc: string, yaml: string) => {
        applied.push(yaml);
      }),
    } as never);
    await expect(service.ensure('kc', 'user-bob')).resolves.toBeUndefined();
    expect(applied).toEqual([]);
  });

  describe('what the LimitRange says', () => {
    const spec = () => {
      const doc = load(buildWorkloadLimitRange('user-alice')) as {
        spec: {
          limits: Array<{
            type: string;
            default?: Record<string, string>;
            defaultRequest?: Record<string, string>;
            max?: Record<string, string>;
          }>;
        };
      };
      return doc.spec.limits[0];
    };

    it('caps what a container writes outside its volumes', () => {
      expect(spec().default?.['ephemeral-storage']).toBe('8Gi');
    });

    /**
     * Explicit, because a LimitRange copies `default` into `defaultRequest`
     * when the latter is omitted — and an 8Gi request would fit eight pods on a
     * node with 71GiB to give.
     */
    it('sets the request too, so the ceiling is not copied into it', () => {
      expect(spec().defaultRequest?.['ephemeral-storage']).toBe('256Mi');
    });

    /**
     * A `max` is refused at pod creation, which is the invisible failure this
     * whole design came out of, and outside a sandbox there is no per-tenant
     * quota for one to protect.
     */
    it('sets no maximum, which would refuse a pod instead of capping it', () => {
      expect(spec().max).toBeUndefined();
    });

    /**
     * The same namespace holds pods Flui never generated — a catalog install, a
     * Helm chart. Handing one of those a memory ceiling it never asked for is
     * help nobody wants.
     */
    it('speaks only about ephemeral storage', () => {
      const limits = spec();
      expect(Object.keys(limits.default ?? {})).toEqual(['ephemeral-storage']);
      expect(Object.keys(limits.defaultRequest ?? {})).toEqual([
        'ephemeral-storage',
      ]);
    });
  });
});
