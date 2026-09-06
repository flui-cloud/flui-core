import * as k8s from '@kubernetes/client-node';

/**
 * A cluster whose host has been powered off does not refuse connections: the
 * packets go nowhere and the kernel retries until it gives up, measured at 133
 * seconds against a machine stopped at Hetzner. Nothing in the client sets a
 * deadline, so every caller inherits that one.
 *
 * It has cost real outages, three times in one campaign: two boot hooks that
 * called every cluster kept the control plane from starting at all (the
 * liveness probe kills at 90 seconds), and a DNS zone assignment for a lost
 * cluster still sat reconciling minutes later.
 */
export const KUBE_REQUEST_TIMEOUT_MS = 25_000;

/** What the generated clients call. Named here to avoid depending on internals. */
interface HttpLibraryLike {
  send(request: {
    getSignal(): unknown;
    setSignal(signal: AbortSignal): void;
  }): unknown;
}

interface ClientWithConfiguration {
  configuration?: { httpApi?: HttpLibraryLike };
}

/**
 * Applied to the KubeConfig rather than to each client: `makeApiClient` is the
 * one door. `KubernetesObjectApi.makeApiClient(kc)` calls it too, which is why
 * wrapping the clients returned by `getKubeClient` was not enough — it missed
 * roughly ten direct call sites, the ones that deploy.
 *
 * Watches, log streaming, exec and port-forward do not come through here: the
 * first two call `fetch` themselves and the last two speak WebSocket. They are
 * meant to stay open, and this deadline would break them.
 */
export function withRequestTimeout(
  kc: k8s.KubeConfig,
  timeoutMs = KUBE_REQUEST_TIMEOUT_MS,
): k8s.KubeConfig {
  const original = kc.makeApiClient.bind(kc);

  kc.makeApiClient = function patched<T>(apiClientType: {
    new (config: unknown): T;
  }): T {
    const client = original(apiClientType as never) as T;
    const httpApi = (client as ClientWithConfiguration).configuration?.httpApi;
    const marked = httpApi as { __fluiTimeout?: boolean } | undefined;

    // Clients made from one KubeConfig share the library, so wrapping per call
    // would stack a deadline for every client ever made from it.
    if (httpApi && !marked?.__fluiTimeout) {
      const send = httpApi.send.bind(httpApi);
      httpApi.send = (request) => {
        // Only when the caller has not brought its own: a request that already
        // carries a signal is being cancelled by someone who knows better.
        if (!request.getSignal()) {
          request.setSignal(AbortSignal.timeout(timeoutMs));
        }
        return send(request);
      };
      marked!.__fluiTimeout = true;
    }
    return client;
  } as typeof kc.makeApiClient;

  return kc;
}
