jest.mock('@kubernetes/client-node', () => ({}));

import {
  KUBE_REQUEST_TIMEOUT_MS,
  withRequestTimeout,
} from './kube-request-timeout.util';

/**
 * A powered-off host swallows the packets rather than refusing them, and the
 * kernel takes 133 seconds to give up — measured against a machine stopped at
 * Hetzner. That deadline reached the control plane's own boot, where the
 * liveness probe kills at 90.
 */
describe('withRequestTimeout', () => {
  function request(signal?: AbortSignal) {
    let current = signal;
    return {
      getSignal: () => current,
      setSignal: (s: AbortSignal) => {
        current = s;
      },
      get signal() {
        return current;
      },
    };
  }

  function kubeConfig() {
    const sent: ReturnType<typeof request>[] = [];
    const httpApi = {
      send: jest.fn((r: ReturnType<typeof request>) => {
        sent.push(r);
        return 'observable';
      }),
    };
    const kc = {
      makeApiClient: jest.fn(() => ({ configuration: { httpApi } })),
    };
    return { kc, httpApi, sent };
  }

  it('gives a request that has no deadline one of its own', () => {
    const h = kubeConfig();
    const client = withRequestTimeout(h.kc as never).makeApiClient(
      class {} as never,
    ) as { configuration: { httpApi: { send: (r: unknown) => unknown } } };
    const r = request();

    client.configuration.httpApi.send(r);

    expect(r.signal).toBeInstanceOf(AbortSignal);
    expect(h.sent).toEqual([r]);
  });

  it('leaves a caller that brought its own alone', () => {
    // Someone cancelling deliberately knows better than a blanket deadline.
    const h = kubeConfig();
    const client = withRequestTimeout(h.kc as never).makeApiClient(
      class {} as never,
    ) as { configuration: { httpApi: { send: (r: unknown) => unknown } } };
    const own = new AbortController().signal;
    const r = request(own);

    client.configuration.httpApi.send(r);

    expect(r.signal).toBe(own);
  });

  it('aborts once the deadline passes', async () => {
    // Real timers: `AbortSignal.timeout` runs on a Node timer jest does not
    // patch, so a faked clock would never fire it and the test would pass
    // against a wrapper that sets no deadline at all.
    const h = kubeConfig();
    const client = withRequestTimeout(h.kc as never, 20).makeApiClient(
      class {} as never,
    ) as { configuration: { httpApi: { send: (r: unknown) => unknown } } };
    const r = request();

    client.configuration.httpApi.send(r);
    expect(r.signal!.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.signal!.aborted).toBe(true);
  });

  it('wraps each library once, however many clients are made', () => {
    // `makeApiClient` is called per client and they share the library; stacking
    // a wrapper per call would set the deadline several times over.
    const h = kubeConfig();
    const kc = withRequestTimeout(h.kc as never);
    kc.makeApiClient(class {} as never);
    kc.makeApiClient(class {} as never);
    const client = kc.makeApiClient(class {} as never) as {
      configuration: { httpApi: { send: (r: unknown) => unknown } };
    };

    client.configuration.httpApi.send(request());

    expect(h.sent).toHaveLength(1);
  });

  it('stays under the ninety seconds the liveness probe allows', () => {
    // Two boot hooks that called every cluster kept the API from ever starting.
    expect(KUBE_REQUEST_TIMEOUT_MS).toBeLessThan(90_000);
  });
});
