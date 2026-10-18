import {
  assembleLinks,
  internalReferences,
  workloadRefLinks,
} from './topology-links.util';
import { TopologyLinkSource, TopologyOverlay } from '../enums/topology.enums';
import { TopologyAppDto, TopologyClusterDto } from '../dto/topology.dto';

const app = (id: string, clusterId: string) =>
  ({ id, clusterId }) as TopologyAppDto;
const cluster = (id: string, overlay: TopologyOverlay) =>
  ({ id, overlay }) as TopologyClusterDto;

const APPS = [
  app('web', 'eu'),
  app('db', 'eu'),
  app('reader', 'us'),
  app('edge', 'asia'),
];
const CLUSTERS = [
  cluster('eu', TopologyOverlay.TUNNEL),
  cluster('us', TopologyOverlay.TUNNEL),
  cluster('asia', TopologyOverlay.PUBLIC_ADDRESS),
];

describe('internalReferences', () => {
  it('reads the app and port an internal host names', () => {
    expect(
      internalReferences(
        'postgres://u:p@orders-db-svc.shop.svc.cluster.local:5432/orders',
      ),
    ).toEqual([{ slug: 'orders-db', namespace: 'shop', port: 5432 }]);
  });

  it('reads several hosts in one value, and none in an external one', () => {
    expect(
      internalReferences(
        'nats://a-svc.x.svc.cluster.local,b-svc.y.svc.cluster.local:4222',
      ),
    ).toEqual([
      { slug: 'a', namespace: 'x', port: null },
      { slug: 'b', namespace: 'y', port: 4222 },
    ]);
    expect(internalReferences('https://api.example.com')).toEqual([]);
  });
});

describe('assembleLinks', () => {
  it('keeps one link per pair, from the strongest source', () => {
    const { links } = assembleLinks(
      [
        {
          from: 'web',
          to: 'db',
          source: TopologyLinkSource.ENV_REFERENCE,
          port: 5432,
        },
        {
          from: 'web',
          to: 'db',
          source: TopologyLinkSource.ATTACHED_SERVICE,
          port: 5432,
        },
      ],
      APPS,
      CLUSTERS,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      source: TopologyLinkSource.ATTACHED_SERVICE,
      label: ':5432',
      crossCluster: false,
      traffic: { measured: false, rps: null, errorPct: null },
    });
  });

  it('labels an ingress HTTPS and carries its host and measured traffic', () => {
    const { links } = assembleLinks(
      [
        {
          from: null,
          to: 'web',
          source: TopologyLinkSource.GATEWAY_ROUTE,
          routeHost: 'shop.example.org',
          traffic: { rps: 120, errorPct: 0.4 },
        },
      ],
      APPS,
      CLUSTERS,
    );
    expect(links[0]).toMatchObject({
      id: 'internet>web',
      from: { kind: 'internet' },
      label: 'HTTPS',
      routeHost: 'shop.example.org',
      traffic: { measured: true, rps: 120, errorPct: 0.4 },
    });
  });

  it('marks a link between clusters, over the tunnel only when both ends are on it', () => {
    const { links, clusterLinks } = assembleLinks(
      [
        {
          from: 'reader',
          to: 'db',
          source: TopologyLinkSource.ENV_REFERENCE,
          port: 5432,
        },
        { from: 'edge', to: 'web', source: TopologyLinkSource.ENV_REFERENCE },
      ],
      APPS,
      CLUSTERS,
    );
    expect(
      links.map((l) => [l.id, l.crossCluster, l.viaTunnel, l.label]),
    ).toEqual([
      ['edge>web', true, false, 'TCP'],
      ['reader>db', true, true, ':5432'],
    ]);
    expect(clusterLinks).toEqual([
      {
        fromClusterId: 'asia',
        toClusterId: 'eu',
        linkCount: 1,
        rps: null,
        viaTunnel: false,
      },
      {
        fromClusterId: 'us',
        toClusterId: 'eu',
        linkCount: 1,
        rps: null,
        viaTunnel: true,
      },
    ]);
  });

  it('drops links to apps the snapshot does not hold, and an app pointing at itself', () => {
    const { links } = assembleLinks(
      [
        { from: 'web', to: 'gone', source: TopologyLinkSource.ENV_REFERENCE },
        { from: 'gone', to: 'web', source: TopologyLinkSource.ENV_REFERENCE },
        { from: 'web', to: 'web', source: TopologyLinkSource.ENV_REFERENCE },
      ],
      APPS,
      CLUSTERS,
    );
    expect(links).toEqual([]);
  });
});

describe('workloadRefLinks', () => {
  const app = (
    id: string,
    clusterId: string,
    namespace: string,
    name: string,
  ) => ({ id, clusterId, namespace, name }) as TopologyAppDto;
  const apps = [
    app('api', 'c1', 'flui-system', 'flui-api'),
    app('pg', 'c1', 'flui-system', 'postgres'),
    app('loki', 'c1', 'flui-control', 'loki'),
    app('shop', 'c1', 'shop', 'shop'),
    app('other-pg', 'c2', 'flui-system', 'postgres'),
  ];

  it('links a workload to the in-cluster hosts its configuration names, on its own cluster only', () => {
    const links = workloadRefLinks(apps, [
      {
        clusterId: 'c1',
        namespace: 'flui-system',
        name: 'flui-api',
        refs: [
          { name: 'postgres', namespace: 'flui-system', port: 5432 },
          { name: 'loki', namespace: 'flui-control', port: 3100 },
          { name: 'nowhere', namespace: 'flui-system', port: null },
        ],
      },
      {
        clusterId: 'c1',
        namespace: 'shop',
        name: 'shop',
        refs: [{ name: 'shop-svc', namespace: 'shop', port: 80 }],
      },
    ]);
    expect(links.map((l) => [l.from, l.to, l.port])).toEqual([
      ['api', 'pg', 5432],
      ['api', 'loki', 3100],
    ]);
  });
});
