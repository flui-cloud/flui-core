// @kubernetes/client-node@1.x ships as ESM, which jest's default
// transformIgnorePatterns won't transpile. We never exercise the real
// port-forward stream here (no socket connects), so a structural stub is enough.
jest.mock('@kubernetes/client-node', () => ({
  PortForward: class {
    portForward(): Promise<void> {
      return Promise.resolve();
    }
  },
  CoreV1Api: class {},
}));

import { NotFoundException } from '@nestjs/common';
import { KubePortForwardService } from './kube-port-forward.service';
import type { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

/**
 * Exercises the tunnel-pooling state machine without a cluster: loopback binds
 * are real, `listNamespacedPod` is stubbed (and counted to prove reuse), and
 * `pf.portForward` is never invoked because no socket connects.
 */
describe('KubePortForwardService (pooling)', () => {
  let listCalls: number;
  let svc: KubePortForwardService;

  const KC = 'kubeconfig-A';
  const NS = 'user-dawit';
  const SEL = 'app=foo';
  const PORT = 5432;

  const pool = () =>
    (svc as any).pool as Map<string, { targetPort: number; closed: boolean }>;

  beforeEach(() => {
    listCalls = 0;
    const fakeKube = {
      makeKubeConfig: () => ({
        makeApiClient: () => ({
          listNamespacedPod: async () => {
            listCalls++;
            return {
              items: [
                { status: { phase: 'Running' }, metadata: { name: 'pod-x' } },
              ],
            };
          },
        }),
      }),
    } as unknown as KubernetesService;
    svc = new KubePortForwardService(fakeKube);
  });

  afterEach(async () => {
    await svc.onModuleDestroy();
  });

  it('builds the tunnel once on first open', async () => {
    const t = await svc.open(KC, NS, SEL, PORT);
    expect(listCalls).toBe(1);
    expect(t.localPort).toBeGreaterThan(0);
    await t.dispose();
  });

  it('reuses a warm tunnel for concurrent and sequential opens to the same target', async () => {
    const first = await svc.open(KC, NS, SEL, PORT);
    const port = first.localPort;
    await first.dispose();

    const [a, b, c] = await Promise.all([
      svc.open(KC, NS, SEL, PORT),
      svc.open(KC, NS, SEL, PORT),
      svc.open(KC, NS, SEL, PORT),
    ]);

    expect(listCalls).toBe(1); // no rebuilds
    expect(a.localPort).toBe(port);
    expect(b.localPort).toBe(port);
    expect(c.localPort).toBe(port);

    await Promise.all([a.dispose(), b.dispose(), c.dispose()]);
  });

  it('keeps a separate tunnel per target port', async () => {
    const a = await svc.open(KC, NS, SEL, PORT);
    const b = await svc.open(KC, NS, SEL, 6379);
    expect(listCalls).toBe(2);
    expect(b.localPort).not.toBe(a.localPort);
    await a.dispose();
    await b.dispose();
  });

  it('stays warm across a dispose with no rebuild', async () => {
    const a = await svc.open(KC, NS, SEL, PORT);
    const port = a.localPort;
    await a.dispose();
    const b = await svc.open(KC, NS, SEL, PORT);
    expect(listCalls).toBe(1);
    expect(b.localPort).toBe(port);
    await b.dispose();
  });

  it('evicts an idle tunnel after the TTL and rebuilds on next open', async () => {
    jest.useFakeTimers();
    try {
      const a = await svc.open(KC, NS, SEL, PORT);
      await a.dispose();
      expect(pool().size).toBe(1);

      // Past the 60s idle window.
      await jest.advanceTimersByTimeAsync(61_000);
      expect(pool().size).toBe(0);

      const b = await svc.open(KC, NS, SEL, PORT);
      expect(listCalls).toBe(2); // rebuilt
      await b.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('self-heals: a retired (broken) tunnel is rebuilt on the next open', async () => {
    const a = await svc.open(KC, NS, SEL, PORT);
    await a.dispose();

    const warm = [...pool().values()].find(
      (x) => x.targetPort === PORT && !x.closed,
    );
    expect(warm).toBeDefined();
    (svc as any).retire(warm, 'simulated forward error');
    expect(pool().size).toBe(0);

    const b = await svc.open(KC, NS, SEL, PORT);
    expect(listCalls).toBe(2);
    await b.dispose();
  });

  it('drops the pool entry when the build finds no running pod', async () => {
    const noPodKube = {
      makeKubeConfig: () => ({
        makeApiClient: () => ({
          listNamespacedPod: async () => ({ items: [] }),
        }),
      }),
    } as unknown as KubernetesService;
    const s = new KubePortForwardService(noPodKube);
    // An absence, and answered as one: this used to be a bare Error, i.e. a 500
    // on a console whose only problem was that nothing was there to talk to.
    await expect(s.open(KC, NS, SEL, PORT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((s as any).pool.size).toBe(0);
    await s.onModuleDestroy();
  });

  it('empties the pool on module destroy', async () => {
    const a = await svc.open(KC, NS, SEL, PORT);
    const b = await svc.open(KC, NS, SEL, 6379);
    expect(pool().size).toBe(2);
    await a.dispose();
    await b.dispose();
    await svc.onModuleDestroy();
    expect(pool().size).toBe(0);
  });
});
