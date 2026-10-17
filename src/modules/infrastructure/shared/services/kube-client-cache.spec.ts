jest.mock('@kubernetes/client-node', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const yaml = require('js-yaml') as { load: (s: string) => any };
  class KubeConfig {
    private doc: any;
    private context: string;
    loadFromString(content: string) {
      this.doc = yaml.load(content);
      this.context = this.doc['current-context'];
    }
    loadFromOptions(options: any) {
      this.doc = {
        clusters: options.clusters.map((c: any) => ({
          name: c.name,
          cluster: c,
        })),
        users: options.users.map((u: any) => ({ name: u.name, user: u })),
        contexts: options.contexts.map((c: any) => ({
          name: c.name,
          context: c,
        })),
      };
      this.context = options.currentContext;
    }
    getCurrentContext() {
      return this.context;
    }
    setCurrentContext(name: string) {
      this.context = name;
    }
    private ctx() {
      return this.doc.contexts.find((c: any) => c.name === this.context)
        ?.context;
    }
    getCurrentCluster() {
      const c = this.doc.clusters.find(
        (x: any) => x.name === this.ctx()?.cluster,
      );
      return (
        c && {
          ...c.cluster,
          skipTLSVerify: !!c.cluster['insecure-skip-tls-verify'],
        }
      );
    }
    getCurrentUser() {
      return this.doc.users.find((x: any) => x.name === this.ctx()?.user)?.user;
    }
    async applyToHTTPSOptions(opts: any) {
      if (this.getCurrentCluster()?.skipTLSVerify)
        opts.rejectUnauthorized = false;
      opts.agent = { library: true };
    }
    async applyToFetchOptions() {
      return { agent: { library: true } };
    }
    async applySecurityAuthentication(context: any) {
      context.setHeaderParam(
        'Authorization',
        `Bearer ${this.getCurrentUser()?.token}`,
      );
      context.setAgent({ library: true });
    }
    makeApiClient(type: new (config: unknown) => unknown) {
      return new type({ kc: this });
    }
  }
  class Api {
    constructor(readonly config: unknown) {}
  }
  return {
    KubeConfig,
    CoreV1Api: class extends Api {},
    AppsV1Api: class extends Api {},
    BatchV1Api: class extends Api {},
    NetworkingV1Api: class extends Api {},
    KubernetesObjectApi: {
      makeApiClient: (kc: KubeConfig) => ({ kc }),
    },
  };
});

import * as https from 'node:https';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from './kubernetes.service';
import {
  KUBE_CLIENT_CACHE_MAX_ENTRIES,
  KUBE_CLIENT_CACHE_TTL_MS,
  KUBE_POOLED_MAX_SOCKETS,
  TtlLruCache,
  kubeconfigCacheKey,
  newPooledKubeConfig,
} from './kube-client-cache';

const kubeconfig = (server: string, user = 'admin') => `apiVersion: v1
kind: Config
clusters:
  - name: c
    cluster:
      server: ${server}
      insecure-skip-tls-verify: true
users:
  - name: ${user}
    user:
      token: secret-${user}
contexts:
  - name: ctx
    context:
      cluster: c
      user: ${user}
      namespace: apps
current-context: ctx
`;

describe('TtlLruCache', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 0;
  });

  it('builds a value once per key while it is fresh', () => {
    const cache = new TtlLruCache<object>(4, 1000, now);
    const create = jest.fn(() => ({}));
    const first = cache.getOrCreate('a', create);
    clock = 999;
    expect(cache.getOrCreate('a', create)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('builds a new value once the TTL has passed, even when read meanwhile', () => {
    const cache = new TtlLruCache<object>(4, 1000, now);
    const first = cache.getOrCreate('a', () => ({}));
    clock = 500;
    cache.getOrCreate('a', () => ({}));
    clock = 1000;
    const second = cache.getOrCreate('a', () => ({}));
    expect(second).not.toBe(first);
    expect(cache.size).toBe(1);
  });

  it('evicts the least recently used key beyond its bound', () => {
    const cache = new TtlLruCache<string>(2, 1000, now);
    cache.getOrCreate('a', () => 'a1');
    cache.getOrCreate('b', () => 'b1');
    cache.getOrCreate('a', () => 'a2');
    cache.getOrCreate('c', () => 'c1');
    expect(cache.size).toBe(2);
    expect(cache.getOrCreate('a', () => 'a3')).toBe('a1');
    expect(cache.getOrCreate('b', () => 'b2')).toBe('b2');
  });

  it('defaults to 64 entries and ten minutes', () => {
    expect(KUBE_CLIENT_CACHE_MAX_ENTRIES).toBe(64);
    expect(KUBE_CLIENT_CACHE_TTL_MS).toBe(600_000);
  });
});

describe('kubeconfigCacheKey', () => {
  it('is a content hash that never contains the kubeconfig', () => {
    const content = kubeconfig('https://10.0.0.1:6443');
    const key = kubeconfigCacheKey(content);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(kubeconfigCacheKey(content));
    expect(key).not.toBe(
      kubeconfigCacheKey(kubeconfig('https://10.0.0.1:6443', 'other')),
    );
  });
});

describe('KubernetesService client caching', () => {
  const a = kubeconfig('https://10.0.0.1:6443');
  const b = kubeconfig('https://10.0.0.2:6443');
  let service: KubernetesService;
  const load = (content: string) =>
    (
      service as unknown as { loadKubeconfig(c: string): k8s.KubeConfig }
    ).loadKubeconfig(content);
  const objectApi = (content: string) =>
    (
      service as unknown as {
        objectApi(c: string): k8s.KubernetesObjectApi;
      }
    ).objectApi(content);

  beforeEach(() => {
    service = new KubernetesService();
  });

  it('parses the same kubeconfig once', () => {
    expect(load(a)).toBe(load(a));
    expect(load(a)).not.toBe(load(b));
  });

  it('reuses the object client, and so its discovery cache', () => {
    expect(objectApi(a)).toBe(objectApi(a));
    expect(objectApi(a)).not.toBe(objectApi(b));
  });

  it('reuses typed clients but hands each caller its own holder', () => {
    const first = service.getKubeClient(a);
    const second = service.getKubeClient(a);
    expect(second).not.toBe(first);
    expect(second.coreApi).toBe(first.coreApi);
    expect(second.appsApi).toBe(first.appsApi);
    expect(service.getKubeClient(b).coreApi).not.toBe(first.coreApi);
  });

  it('gives makeKubeConfig callers a private instance they may change', () => {
    const own = service.makeKubeConfig(a);
    expect(own).not.toBe(service.makeKubeConfig(a));
    expect(own).not.toBe(load(a));
    own.setCurrentContext('elsewhere');
    expect(load(a).getCurrentContext()).toBe('ctx');
  });

  it('keys on the server override, so a changed override is a new entry', () => {
    const previous = process.env.KUBECONFIG_SERVER_OVERRIDE;
    try {
      const plain = load(a);
      process.env.KUBECONFIG_SERVER_OVERRIDE = 'https://127.0.0.1:16443';
      const overridden = load(a);
      expect(overridden).not.toBe(plain);
      expect(overridden.getCurrentCluster()?.server).toBe(
        'https://127.0.0.1:16443',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.KUBECONFIG_SERVER_OVERRIDE;
      } else {
        process.env.KUBECONFIG_SERVER_OVERRIDE = previous;
      }
    }
  });
});

describe('pooled KubeConfig', () => {
  const contextFor = (kc: k8s.KubeConfig) => {
    let agent: unknown;
    const headers: Record<string, string> = {};
    const context = {
      setAgent: (value: unknown) => (agent = value),
      setHeaderParam: (k: string, v: string) => (headers[k] = v),
    };
    return {
      apply: () =>
        kc.applySecurityAuthentication(context as never).then(() => agent),
      headers,
    };
  };

  const pooled = (content: string) => {
    const kc = newPooledKubeConfig();
    kc.loadFromString(content);
    return kc;
  };

  it('sends every API request through one bounded keep-alive agent', async () => {
    const kc = pooled(kubeconfig('https://10.0.0.1:6443'));
    const first = contextFor(kc);
    const agent = (await first.apply()) as https.Agent;
    const again = await contextFor(kc).apply();

    expect(agent).toBeInstanceOf(https.Agent);
    expect(again).toBe(agent);
    expect((agent as unknown as { keepAlive: boolean }).keepAlive).toBe(true);
    expect(agent.maxSockets).toBe(KUBE_POOLED_MAX_SOCKETS);
    expect(
      (agent as unknown as { options: https.AgentOptions }).options
        .rejectUnauthorized,
    ).toBe(false);
    expect(first.headers.Authorization).toBe('Bearer secret-admin');
  });

  it('leaves exec users on the library agent', async () => {
    const kc = newPooledKubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: 'c', server: 'https://10.0.0.1:6443' }],
      users: [{ name: 'u', exec: { command: 'true' } }],
      contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
      currentContext: 'x',
    });
    expect(await contextFor(kc).apply()).toEqual({ library: true });
  });

  it('leaves plain-http clusters on the library agent', async () => {
    const kc = pooled(kubeconfig('http://10.0.0.1:8080'));
    expect(await contextFor(kc).apply()).toEqual({ library: true });
  });

  it('keeps the library agent for watch-style fetch options', async () => {
    const kc = pooled(kubeconfig('https://10.0.0.1:6443'));
    const api = await contextFor(kc).apply();
    const fetchOptions = await kc.applyToFetchOptions({});
    expect(fetchOptions.agent).not.toBe(api);
  });
});
