import * as yaml from 'js-yaml';
import { buildSandboxNetworkPolicy } from './sandbox-network-policy.manifest';
import { buildNoindexMiddleware, SANDBOX_ROBOTS_TXT } from './sandbox-noindex';
import { buildPrepullManifest } from './sandbox-prepull.manifest';
import { isFastCatalogApp, SEEDED_METADATA } from './sandbox-seed';

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

  it('keeps the internet reachable, because an app that cannot call out proves less', () => {
    const internet = policy().spec.egress.find((e: any) =>
      e.to?.some((t: any) => t.ipBlock?.cidr === '0.0.0.0/0'),
    );
    expect(internet).toBeTruthy();
  });

  it('closes the private ranges and the metadata address inside that opening', () => {
    const except = policy()
      .spec.egress.find((e: any) => e.to?.some((t: any) => t.ipBlock))
      .to.find((t: any) => t.ipBlock).ipBlock.except;
    expect(except).toContain('169.254.0.0/16');
    expect(except).toContain('10.0.0.0/8');
    expect(except).toContain('172.16.0.0/12');
    expect(except).toContain('192.168.0.0/16');
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

  it('also refuses crawlers that never fetch a page first', () => {
    expect(SANDBOX_ROBOTS_TXT).toContain('Disallow: /');
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

describe('the seed', () => {
  it('declares itself as seeded, because unlabelled content reads as a leak', () => {
    expect(SEEDED_METADATA['flui.cloud/seeded']).toBe('true');
    expect(SEEDED_METADATA['flui.cloud/seeded-note']).toContain(
      'Seeded by Flui',
    );
  });

  it('keeps the heavy catalog applications out of the guided path', () => {
    expect(isFastCatalogApp('gitea')).toBe(true);
    expect(isFastCatalogApp('immich')).toBe(false);
    expect(isFastCatalogApp('nextcloud')).toBe(false);
  });
});
