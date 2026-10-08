import * as yaml from 'js-yaml';
import { buildSandboxNetworkPolicy } from './sandbox-network-policy.manifest';
import { buildNoindexMiddleware } from './sandbox-noindex';
import { buildPrepullManifest } from './sandbox-prepull.manifest';
import { isFastCatalogApp } from './sandbox-seed';

describe('network policy around a tenancy', () => {
  const policy = () =>
    yaml.load(buildSandboxNetworkPolicy('guest-1')) as Record<string, any>;

  it('governs both directions', () => {
    expect(policy().spec.policyTypes).toEqual(['Ingress', 'Egress']);
  });

  it('applies to every pod in the tenancy, not a labelled subset', () => {
    expect(policy().spec.podSelector).toEqual({});
  });

  // The shortest path from "shared instance" to "a stranger read your data" is
  // one guest resolving another guest's database service.
  it('lets nothing in except the ingress and the tenancy itself', () => {
    const from = policy().spec.ingress[0].from;
    const namespaces = from
      .filter((f: any) => f.namespaceSelector)
      .map(
        (f: any) =>
          f.namespaceSelector.matchLabels['kubernetes.io/metadata.name'],
      );
    expect(namespaces).toEqual(['kube-system']);
    expect(from.some((f: any) => f.podSelector)).toBe(true);
  });

  /**
   * The rule the demo actually runs on: a host-networked Traefik can never match
   * a selector, so before this every application a guest deployed answered 502
   * and never got a certificate. The address is on the pod network, not the
   * node's — the caller was measured as `10.42.0.0`.
   */
  it('lets the ingress controller in by address, since it cannot be matched by selector', () => {
    const from = policy().spec.ingress[0].from;
    const cidrs = from
      .filter((f: any) => f.ipBlock)
      .map((f: any) => f.ipBlock.cidr);
    expect(cidrs).toContain('10.42.0.0/31');
    expect(cidrs).toContain('10.42.255.0/31');
  });

  /**
   * Two addresses per node — the CNI's own — and never a pod's. A `/16` was
   * measured letting one tenancy reach another's service, which is the sentence
   * this fence exists to prevent.
   */
  it('opens no address a pod could hold', () => {
    const from = policy().spec.ingress[0].from;
    const cidrs: string[] = from
      .filter((f: any) => f.ipBlock)
      .map((f: any) => f.ipBlock.cidr);
    expect(cidrs.some((c) => /\/(8|16|24)$/.test(c))).toBe(false);
    for (const cidr of cidrs) expect(cidr).toMatch(/^10\.42\.\d{1,3}\.0\/31$/);
  });

  /**
   * The widening is one direction only, and the way out to the internet is not
   * this policy's: it lives in the egress policy, so that a port closed there
   * is not opened again here.
   */
  it('opens no address outside the tenancy on the way out', () => {
    const egress = policy().spec.egress;
    expect(egress.some((e: any) => e.to?.some((t: any) => t.ipBlock))).toBe(
      false,
    );
  });

  it('still allows DNS, without which nothing works at all', () => {
    const dns = policy().spec.egress.find((e: any) =>
      e.ports?.some((p: any) => p.port === 53),
    );
    expect(dns.ports.map((p: any) => p.protocol).sort()).toEqual([
      'TCP',
      'UDP',
    ]);
  });
});

describe('keeping guest applications out of search results', () => {
  it('sets the header at the ingress rather than asking the application', () => {
    const mw = yaml.load(buildNoindexMiddleware('guest-1')) as Record<
      string,
      any
    >;
    expect(mw.kind).toBe('Middleware');
    expect(mw.spec.headers.customResponseHeaders['X-Robots-Tag']).toContain(
      'noindex',
    );
    expect(mw.spec.headers.customResponseHeaders['X-Robots-Tag']).toContain(
      'nofollow',
    );
  });
});

describe('image pre-pull', () => {
  const ds = () =>
    yaml.load(
      buildPrepullManifest('flui-system', [
        'gitea:1.22',
        'codercom/code-server:4',
      ]),
    ) as Record<string, any>;

  it('reaches every node a guest could land on', () => {
    expect(ds().kind).toBe('DaemonSet');
    expect(ds().spec.template.spec.tolerations).toEqual([
      { operator: 'Exists' },
    ]);
  });

  it('pulls in init containers so nothing keeps running afterwards', () => {
    const spec = ds().spec.template.spec;
    expect(spec.initContainers).toHaveLength(2);
    expect(spec.containers[0].image).toContain('pause');
  });

  // Warming a cache is not worth evicting the guest workload it was meant to serve.
  it('asks for almost nothing and cannot be evicted for it', () => {
    const spec = ds().spec.template.spec;
    expect(spec.priorityClassName).toBe('system-node-critical');
    expect(spec.initContainers[0].resources.limits.memory).toBe('64Mi');
  });
});

describe('the guided path', () => {
  it('keeps the heavy catalog applications out of it', () => {
    expect(isFastCatalogApp('gitea')).toBe(true);
    expect(isFastCatalogApp('immich')).toBe(false);
    expect(isFastCatalogApp('nextcloud')).toBe(false);
  });
});
