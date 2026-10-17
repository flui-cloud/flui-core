import { createHash } from 'node:crypto';
import * as https from 'node:https';
import * as k8s from '@kubernetes/client-node';

export const KUBE_CLIENT_CACHE_MAX_ENTRIES = 64;
export const KUBE_CLIENT_CACHE_TTL_MS = 10 * 60_000;
export const KUBE_POOLED_MAX_SOCKETS = 32;
export const KUBE_POOLED_MAX_FREE_SOCKETS = 8;
export const KUBE_POOLED_SOCKET_TIMEOUT_MS = 60_000;

export const kubeconfigCacheKey = (kubeconfig: string): string =>
  createHash('sha256').update(kubeconfig).digest('hex');

/**
 * The TTL runs from creation, not from the last read: a client keeps serving
 * no longer than the TTL whatever happens to the credentials behind it.
 */
export class TtlLruCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries = KUBE_CLIENT_CACHE_MAX_ENTRIES,
    private readonly ttlMs = KUBE_CLIENT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly onEvict?: (value: V) => void,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  getOrCreate(key: string, create: () => V): V {
    const hit = this.entries.get(key);
    this.entries.delete(key);
    if (hit && hit.expiresAt > this.now()) {
      this.entries.set(key, hit);
      return hit.value;
    }
    if (hit) this.onEvict?.(hit.value);
    const value = create();
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) this.onEvict?.(evicted.value);
    }
    return value;
  }
}

type RequestContextLike = Parameters<
  k8s.KubeConfig['applySecurityAuthentication']
>[0];

let pooledKubeConfigClass: (new () => k8s.KubeConfig) | undefined;

/**
 * A KubeConfig whose API requests share one keep-alive agent instead of the
 * fresh agent, and so fresh TLS handshake, the library makes per request.
 *
 * Only API clients are affected: watch and log fetch through
 * applyToFetchOptions, exec and port-forward through applyToHTTPSOptions, and
 * both keep the library's own agent. Proxied clusters and exec or
 * auth-provider users, whose TLS material may change between requests, keep
 * it too.
 *
 * Built on first use because many specs replace the library with an empty
 * module, and a class extending it at import time would fail to load.
 */
export function newPooledKubeConfig(): k8s.KubeConfig {
  pooledKubeConfigClass ??= class PooledKubeConfig extends k8s.KubeConfig {
    private pooledAgent?: Promise<https.Agent | undefined>;

    override async applySecurityAuthentication(
      context: RequestContextLike,
    ): Promise<void> {
      await super.applySecurityAuthentication(context);
      this.pooledAgent ??= this.createPooledAgent().catch(() => undefined);
      const agent = await this.pooledAgent;
      if (agent) {
        context.setAgent(agent);
      }
    }

    destroyPooledAgent(): void {
      void this.pooledAgent?.then((agent) => agent?.destroy());
      this.pooledAgent = undefined;
    }

    private async createPooledAgent(): Promise<https.Agent | undefined> {
      const cluster = this.getCurrentCluster();
      const user = this.getCurrentUser();
      if (
        !cluster?.server?.startsWith('https:') ||
        cluster.proxyUrl ||
        user?.exec ||
        user?.authProvider
      ) {
        return undefined;
      }
      const tls: https.RequestOptions = {};
      await this.applyToHTTPSOptions(tls);
      return new https.Agent({
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        pfx: tls.pfx,
        passphrase: tls.passphrase,
        servername: tls.servername,
        ...(tls.rejectUnauthorized === undefined
          ? {}
          : { rejectUnauthorized: tls.rejectUnauthorized }),
        keepAlive: true,
        timeout: KUBE_POOLED_SOCKET_TIMEOUT_MS,
        maxSockets: KUBE_POOLED_MAX_SOCKETS,
        maxFreeSockets: KUBE_POOLED_MAX_FREE_SOCKETS,
      });
    }
  };
  return new pooledKubeConfigClass();
}

/** Close the keep-alive sockets of a KubeConfig leaving the cache. */
export function releaseKubeConfig(kc: k8s.KubeConfig): void {
  (kc as { destroyPooledAgent?: () => void }).destroyPooledAgent?.();
}
