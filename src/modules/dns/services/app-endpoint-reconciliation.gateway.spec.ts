jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { AppEndpointReconciliationService } from './app-endpoint-reconciliation.service';
import { GatewayMiddlewareCompilerService } from './gateway-middleware-compiler.service';
import { apiVersionForKind } from '../../infrastructure/shared/utils/kube-api-version.util';
import { EndpointGatewayConfig } from '../interfaces/endpoint-gateway-config.interface';

type Obj = Record<string, any>;

function mergePatch(target: Obj, patch: Obj): Obj {
  const out: Obj = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof out[key] === 'object' &&
      out[key] !== null
    )
      out[key] = mergePatch(out[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * Stands in for the cluster with the one behaviour that matters here: an
 * existing object is updated by a JSON merge patch, so a key left out of the
 * manifest keeps its old value and only an explicit null removes it.
 */
class FakeCluster {
  readonly objects = new Map<string, Obj>();
  private readonly apiVersionOf = apiVersionForKind;

  private key(apiVersion: string, kind: string, ns: string, name: string) {
    return `${apiVersion}|${kind}|${ns}|${name}`;
  }

  applyManifest = jest.fn(async (_kc: string, json: string) => {
    const spec = JSON.parse(json);
    const k = this.key(
      spec.apiVersion,
      spec.kind,
      spec.metadata.namespace,
      spec.metadata.name,
    );
    const existing = this.objects.get(k);
    if (!existing) {
      const created = JSON.parse(json, (_k, v) => (v === null ? undefined : v));
      this.objects.set(k, created);
    } else {
      this.objects.set(k, mergePatch(existing, spec));
    }
    return [];
  });

  getResource = jest.fn(
    async (_kc: string, kind: string, name: string, ns: string) =>
      this.objects.get(this.key(this.apiVersionOf(kind), kind, ns, name)) ??
      null,
  );

  deleteResource = jest.fn(
    async (_kc: string, kind: string, name: string, ns: string) => {
      this.objects.delete(this.key(this.apiVersionOf(kind), kind, ns, name));
    },
  );

  listResourcesByLabel = jest.fn(
    async (_kc: string, kind: string, ns: string, selector: string) => {
      const [labelKey, labelValue] = selector.split('=');
      const apiVersion = this.apiVersionOf(kind);
      return [...this.objects.entries()]
        .filter(([k]) => k.startsWith(`${apiVersion}|${kind}|${ns}|`))
        .map(([, o]) => o)
        .filter((o) => o.metadata?.labels?.[labelKey] === labelValue);
    },
  );

  patchKubeconfigServer = jest.fn((kc: string) => kc);

  ingress(ns: string, name: string): Obj | undefined {
    return this.objects.get(
      this.key('networking.k8s.io/v1', 'Ingress', ns, name),
    );
  }

  middlewareNames(ns: string): string[] {
    return [...this.objects.values()]
      .filter((o) => o.kind === 'Middleware' && o.metadata.namespace === ns)
      .map((o) => o.metadata.name)
      .sort();
  }
}

const NS = 'user-alice';
const MIDDLEWARES_ANNOTATION =
  'traefik.ingress.kubernetes.io/router.middlewares';

function makeEndpoint(id: string, gatewayConfig: EndpointGatewayConfig | null) {
  return {
    id,
    clusterId: 'cluster-1',
    fqdn: `${id.split('-')[0]}.example.test`,
    k8sNamespace: NS,
    k8sServiceName: 'whoami-svc',
    k8sServicePort: 80,
    endpointType: 'public',
    certificateRequired: false,
    gatewayConfig,
  };
}

function build(cluster: FakeCluster, liveEndpointIds: string[]) {
  const appEndpoints = {
    listByNamespace: jest
      .fn()
      .mockResolvedValue(liveEndpointIds.map((id) => ({ id }))),
  };
  const service = new AppEndpointReconciliationService(
    null as never,
    cluster as never,
    { decrypt: jest.fn().mockReturnValue('kubeconfig') } as never,
    null as never,
    null as never,
    appEndpoints as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    new GatewayMiddlewareCompilerService(),
    { exists: jest.fn().mockResolvedValue(false) } as never,
    null as never,
  );
  const reconcileIngress = (endpoint: ReturnType<typeof makeEndpoint>) =>
    (
      service as unknown as {
        reconcileIngress: (
          e: unknown,
          zone: unknown,
          c: unknown,
        ) => Promise<void>;
      }
    ).reconcileIngress(endpoint, null, {
      id: 'cluster-1',
      kubeconfigEncrypted: 'enc',
    });
  return { service, reconcileIngress };
}

describe('AppEndpointReconciliationService — gateway policies on the cluster', () => {
  const ID = 'cd7b541c-0000-4000-8000-000000000001';
  const ingressName = `whoami-svc-cd7b541c-ingress`;

  it.each<[string, EndpointGatewayConfig]>([
    ['IP filter', { allowIps: ['203.0.113.0/24'] }],
    ['rate limit', { rateLimit: { average: 2, burst: 2 } }],
  ])(
    'removing the last policy (%s) clears the Ingress middlewares and deletes the middleware',
    async (_label, config) => {
      const cluster = new FakeCluster();
      const { reconcileIngress } = build(cluster, [ID]);

      await reconcileIngress(makeEndpoint(ID, config));
      expect(
        cluster.ingress(NS, ingressName)?.metadata.annotations[
          MIDDLEWARES_ANNOTATION
        ],
      ).toMatch(/flui-gw-cd7b541c-/);
      expect(cluster.middlewareNames(NS)).toHaveLength(1);

      await reconcileIngress(makeEndpoint(ID, null));

      expect(
        cluster.ingress(NS, ingressName)?.metadata.annotations,
      ).not.toHaveProperty([MIDDLEWARES_ANNOTATION]);
      expect(cluster.middlewareNames(NS)).toEqual([]);
    },
  );

  it('keeps the remaining policy when only one of two is removed', async () => {
    const cluster = new FakeCluster();
    const { reconcileIngress } = build(cluster, [ID]);

    await reconcileIngress(
      makeEndpoint(ID, {
        allowIps: ['203.0.113.0/24'],
        rateLimit: { average: 2 },
      }),
    );
    await reconcileIngress(makeEndpoint(ID, { rateLimit: { average: 2 } }));

    expect(
      cluster.ingress(NS, ingressName)?.metadata.annotations[
        MIDDLEWARES_ANNOTATION
      ],
    ).toBe(`${NS}-flui-gw-cd7b541c-ratelimit@kubernetescrd`);
    expect(cluster.middlewareNames(NS)).toEqual(['flui-gw-cd7b541c-ratelimit']);
  });

  it('deletes the middlewares of a route that no longer exists in the namespace', async () => {
    const GONE = '39f22aa4-0000-4000-8000-000000000002';
    const cluster = new FakeCluster();
    await build(cluster, [ID, GONE]).reconcileIngress(
      makeEndpoint(GONE, { allowIps: ['203.0.113.0/24'] }),
    );
    expect(cluster.middlewareNames(NS)).toEqual(['flui-gw-39f22aa4-allowlist']);

    await build(cluster, [ID]).reconcileIngress(makeEndpoint(ID, null));

    expect(cluster.middlewareNames(NS)).toEqual([]);
  });
});
