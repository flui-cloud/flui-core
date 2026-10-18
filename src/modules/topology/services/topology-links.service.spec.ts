jest.mock('@kubernetes/client-node', () => ({}));

import { TopologyLinksService } from './topology-links.service';
import {
  TopologyAppDto,
  TopologyClusterDto,
  TopologyStackDto,
} from '../dto/topology.dto';
import { TopologyLinkSource, TopologyOverlay } from '../enums/topology.enums';

const SECRET = 'postgres://admin:s3cr3t@db-svc.shop.svc.cluster.local:5432/app';
const PLAIN = 'redis://cache-svc.shop.svc.cluster.local:6379';

const ROWS = [
  {
    id: 'web',
    slug: 'web',
    k8sNamespace: 'shop',
    port: 3000,
    portProtocol: 'http',
    env: [
      { name: 'DATABASE_URL', value: SECRET, secret: true },
      { name: 'REDIS_URL', value: PLAIN },
    ],
  },
  { id: 'db', slug: 'db', k8sNamespace: 'shop', port: 5432, env: [] },
  { id: 'cache', slug: 'cache', k8sNamespace: 'shop', port: 6379, env: [] },
  { id: 'api', slug: 'api', k8sNamespace: 'shop', port: 8080, env: [] },
];

const APPS = ['web', 'db', 'cache', 'api'].map(
  (id) => ({ id, clusterId: 'eu' }) as TopologyAppDto,
);
const STACKS = [
  { id: 'install-shop', type: 'composed', primaryAppId: 'web' },
  { id: 'install-api', type: 'composed', primaryAppId: 'api' },
] as TopologyStackDto[];
const CLUSTERS = [
  { id: 'eu', overlay: TopologyOverlay.TUNNEL },
] as TopologyClusterDto[];

function make(traffic: { fails?: boolean } = {}) {
  const repo = (rows: unknown[]) => ({ find: jest.fn(async () => rows) });
  const service = new TopologyLinksService(
    repo(ROWS) as never,
    repo([
      { applicationId: 'web', bbApplicationId: 'db', catalogInstallId: null },
    ]) as never,
    repo([
      { id: 'install-shop', dependencyInstallIds: ['install-api'] },
    ]) as never,
    repo([
      {
        applicationId: 'web',
        fqdn: 'shop.example.org',
        routePath: '/api',
        k8sServicePort: 3000,
      },
    ]) as never,
    {
      getClusterTrafficByService: jest.fn(async () => {
        if (traffic.fails) throw new Error('vmsingle unreachable');
        return new Map();
      }),
      summaryFor: jest.fn(() => ({
        rps: 42,
        serverErrorPercent: 1.5,
        p95: 0.2,
      })),
    } as never,
  );
  return service;
}

describe('TopologyLinksService', () => {
  it('reads a link from every source Flui knows', async () => {
    const { links } = await make().build(APPS, STACKS, CLUSTERS);
    expect(links.map((l) => [l.id, l.source, l.label])).toEqual([
      ['internet>web', TopologyLinkSource.GATEWAY_ROUTE, 'HTTPS'],
      ['web>api', TopologyLinkSource.CATALOG_DEPENDENCY, ':8080'],
      ['web>cache', TopologyLinkSource.ENV_REFERENCE, ':6379'],
      ['web>db', TopologyLinkSource.ATTACHED_SERVICE, ':5432'],
    ]);
    expect(links[0].traffic).toEqual({
      measured: true,
      rps: 42,
      errorPct: 1.5,
    });
  });

  it('says where a gateway route answers and which app port it delivers to', async () => {
    const { links } = await make().build(APPS, STACKS, CLUSTERS);
    const route = links.find(
      (l) => l.source === TopologyLinkSource.GATEWAY_ROUTE,
    )!;
    expect([route.routeHost, route.routePath, route.targetPort]).toEqual([
      'shop.example.org',
      '/api',
      3000,
    ]);
    const internal = links.find((l) => l.id === 'web>db')!;
    expect([internal.routePath, internal.targetPort]).toEqual([null, null]);
  });

  it('never returns a variable value, secret or not', async () => {
    const json = JSON.stringify(await make().build(APPS, STACKS, CLUSTERS));
    expect(json).not.toContain('s3cr3t');
    expect(json).not.toContain('redis://');
    expect(json).not.toContain('svc.cluster.local');
  });

  it('still draws the links when traffic cannot be read, unmeasured', async () => {
    const { links } = await make({ fails: true }).build(APPS, STACKS, CLUSTERS);
    expect(links.find((l) => l.id === 'internet>web')?.traffic).toEqual({
      measured: false,
      rps: null,
      errorPct: null,
    });
  });

  it('leaves platform workloads, whose ids are not records, out of the record queries', async () => {
    const service = make();
    const apps = [
      ...APPS,
      { id: 'flui-control/alertmanager', clusterId: 'eu' } as TopologyAppDto,
    ];
    await service.build(apps, STACKS, CLUSTERS);
    const repo = (service as unknown as { appRepo: { find: jest.Mock } })
      .appRepo;
    expect(JSON.stringify(repo.find.mock.calls)).not.toContain('alertmanager');
  });

  it('asks nothing when there are no apps', async () => {
    expect(await make().build([], STACKS, CLUSTERS)).toEqual({
      links: [],
      clusterLinks: [],
    });
  });
});
