/**
 * The example organisation's whole fleet, as the Topology page draws it.
 *
 * The main cluster is the one every other section already describes: its
 * machines are `MACHINES`, its first four applications are `APPS`, with the
 * same ids. The other clusters exist only here and in the instances list, so
 * nothing a guest opens from Topology lands on a page that has never heard of
 * it.
 *
 * Shaped like a small SaaS company on an ordinary afternoon: busy, well run,
 * with three things worth a look and no more — a billing API that keeps
 * running out of memory, an edge proxy that restarts, and the Asia cluster
 * reached on its public address while its tunnel is held.
 */
import { WorldClusterId, WorldServer } from './sandbox-world-topology-fleet';
import {
  ASIA,
  CONTROL,
  EU,
  STAGING,
  US,
  WorldApp,
} from './sandbox-world-topology-apps';
import { WORLD_APPS_EU_A } from './sandbox-world-topology-apps-eu';
import { WORLD_APPS_EU_B } from './sandbox-world-topology-apps-eu-2';
import { WORLD_APPS_OTHER } from './sandbox-world-topology-apps-other';
import { WORLD_APPS_CONTROL } from './sandbox-world-topology-apps-control';

export * from './sandbox-world-topology-fleet';
export * from './sandbox-world-topology-apps';

export const WORLD_APPS: WorldApp[] = [
  ...WORLD_APPS_EU_A,
  ...WORLD_APPS_EU_B,
  ...WORLD_APPS_OTHER,
  ...WORLD_APPS_CONTROL,
];

export interface WorldLink {
  from: string | null;
  to: string;
  source:
    | 'gateway-route'
    | 'attached-service'
    | 'catalog-dependency'
    | 'env-reference';
  /** Requests per second at the middle of the swing, gateway routes only. */
  rps?: number;
  errorPct?: number;
  /** The path a gateway route answers on. */
  path?: string;
  host?: string;
}

const key = (clusterId: WorldClusterId, slug: string) =>
  WORLD_APPS.find((a) => a.clusterId === clusterId && a.slug === slug)!.id;

const route = (
  clusterId: WorldClusterId,
  slug: string,
  rps: number,
  errorPct: number,
  host: string,
  path = '/',
): WorldLink => ({
  from: null,
  to: key(clusterId, slug),
  source: 'gateway-route',
  rps,
  errorPct,
  host,
  path,
});

const uses = (
  clusterId: WorldClusterId,
  from: string,
  to: string,
  source: WorldLink['source'] = 'attached-service',
  toCluster: WorldClusterId = clusterId,
): WorldLink => ({
  from: key(clusterId, from),
  to: key(toCluster, to),
  source,
});

export const WORLD_LINKS: WorldLink[] = [
  route(EU, 'storefront', 380, 0.2, 'shop.northwind-labs.eu'),
  route(EU, 'auth', 120, 0.1, 'id.northwind-labs.eu'),
  route(EU, 'billing-api', 18, 64, 'billing.northwind-labs.eu'),
  route(EU, 'cms', 45, 0.4, 'cms.northwind-labs.eu'),
  route(EU, 'notify-api', 30, 0.3, 'notify.northwind-labs.eu', '/v1'),
  route(EU, 'plausible', 210, 0.1, 'stats.northwind-labs.eu'),
  route(EU, 'metabase', 4, 0, 'bi.northwind-labs.eu'),
  route(EU, 'n8n', 12, 0.8, 'flows.northwind-labs.eu'),
  route(EU, 'imgproxy', 160, 0.2, 'img.northwind-labs.eu'),
  route(EU, 'umami', 60, 0.1, 'u.northwind-labs.eu'),
  route(EU, 'status-page', 15, 0, 'status.northwind-labs.eu'),
  route(EU, 'docs', 22, 0, 'docs.northwind-labs.eu'),
  route(EU, 'webhooks-relay', 9, 1.2, 'hooks.northwind-labs.eu', '/in'),
  route(US, 'storefront', 140, 0.3, 'us.shop.northwind-labs.eu'),
  route(US, 'auth-proxy', 35, 0.2, 'us.id.northwind-labs.eu'),
  route(US, 'docs', 6, 0, 'us.docs.northwind-labs.eu'),
  route(ASIA, 'edge-cache', 90, 0.5, 'asia.shop.northwind-labs.eu'),
  route(CONTROL, 'flui-api', 6, 0, 'api.northwind-labs.eu'),
  route(CONTROL, 'flui-web', 3, 0, 'flui.northwind-labs.eu'),
  route(CONTROL, 'zitadel', 2, 0, 'login.northwind-labs.eu'),
  route(STAGING, 'storefront', 1, 0, 'staging.shop.northwind-labs.eu'),

  uses(EU, 'storefront', 'orders-api', 'env-reference'),
  uses(EU, 'storefront', 'session-cache'),
  uses(EU, 'storefront', 'search', 'env-reference'),
  uses(EU, 'storefront', 'imgproxy', 'env-reference'),
  uses(EU, 'orders-api', 'orders-db'),
  uses(EU, 'orders-api', 'nats', 'env-reference'),
  uses(EU, 'orders-worker', 'orders-db'),
  uses(EU, 'orders-worker', 'nats', 'env-reference'),
  uses(EU, 'auth', 'auth-db'),
  uses(EU, 'billing-api', 'billing-db'),
  uses(EU, 'billing-worker', 'billing-db'),
  uses(EU, 'billing-worker', 'nats', 'env-reference'),
  uses(EU, 'search-indexer', 'search'),
  uses(EU, 'search-indexer', 'orders-db', 'env-reference'),
  uses(EU, 'cms', 'cms-db'),
  uses(EU, 'cms', 'media-store', 'catalog-dependency'),
  uses(EU, 'notify-api', 'rabbitmq'),
  uses(EU, 'notify-worker', 'rabbitmq'),
  uses(EU, 'plausible', 'clickhouse'),
  uses(EU, 'plausible', 'plausible-db'),
  uses(EU, 'metabase', 'metabase-db'),
  uses(EU, 'metabase', 'clickhouse', 'env-reference'),
  uses(EU, 'n8n', 'n8n-db'),
  uses(EU, 'n8n-worker', 'n8n-db'),
  uses(EU, 'n8n-worker', 'redis-cache', 'env-reference'),
  uses(EU, 'imgproxy', 'media-store', 'env-reference'),
  uses(US, 'storefront', 'session-cache'),
  uses(US, 'storefront', 'search', 'env-reference'),
  uses(ASIA, 'edge-cache', 'edge-api', 'env-reference'),
  uses(ASIA, 'edge-cache', 'image-cache', 'env-reference'),
  uses(ASIA, 'edge-api', 'edge-sessions'),
  uses(CONTROL, 'flui-api', 'postgres', 'env-reference'),
  uses(CONTROL, 'flui-api', 'redis', 'env-reference'),
  uses(CONTROL, 'zitadel', 'postgres', 'env-reference'),
  uses(CONTROL, 'vmagent', 'vmsingle', 'env-reference'),
  uses(CONTROL, 'vmalert', 'vmsingle', 'env-reference'),
  uses(CONTROL, 'vmalert', 'alertmanager', 'env-reference'),
  uses(CONTROL, 'grafana', 'vmsingle', 'env-reference'),
  uses(CONTROL, 'grafana', 'loki', 'env-reference'),
  uses(STAGING, 'orders-api', 'orders-db'),
  uses(STAGING, 'storefront', 'orders-api', 'env-reference'),
];

/** What a server's own platform pods reserve, before any app. */
const SYSTEM_RESERVE = {
  master: { memMi: 1200, cpuM: 600 },
  worker: { memMi: 450, cpuM: 200 },
};

/**
 * What a server has reserved: the requests of the apps placed on it, plus what
 * its platform pods hold. Derived, so Topology, Capacity and Scaling agree.
 */
export function worldRequested(server: WorldServer): {
  memMi: number;
  cpuM: number;
} {
  const reserve = SYSTEM_RESERVE[server.role];
  return WORLD_APPS.filter(
    (a) => a.clusterId === server.clusterId && a.on[server.name],
  ).reduce(
    (sum, a) => ({
      memMi: sum.memMi + a.ramMb * a.on[server.name],
      cpuM: sum.cpuM + a.cpuM * a.on[server.name],
    }),
    { ...reserve },
  );
}

/** Projects the example apps belong to: a shop, its back office, its numbers, and a few apps in none. */
export const WORLD_PROJECTS = [
  { id: 'example-project-shop', name: 'Shop' },
  { id: 'example-project-back-office', name: 'Back office' },
  { id: 'example-project-insights', name: 'Insights' },
] as const;

const PROJECT_OF_STACK: Record<string, string> = {
  storefront: 'example-project-shop',
  orders: 'example-project-shop',
  auth: 'example-project-shop',
  search: 'example-project-shop',
  cms: 'example-project-shop',
  media: 'example-project-shop',
  'cache-queue': 'example-project-shop',
  'storefront-us': 'example-project-shop',
  'orders-us': 'example-project-shop',
  'edge-asia': 'example-project-shop',
  'staging-shop': 'example-project-shop',
  billing: 'example-project-back-office',
  notifications: 'example-project-back-office',
  automation: 'example-project-back-office',
  analytics: 'example-project-insights',
  bi: 'example-project-insights',
};

const PROJECT_OF_SLUG: Record<string, string> = {
  docs: 'example-project-shop',
  'webhooks-relay': 'example-project-back-office',
  'cron-runner': 'example-project-back-office',
  'internal-tools': 'example-project-back-office',
  umami: 'example-project-insights',
  'status-page': 'example-project-insights',
  'uptime-kuma': 'example-project-insights',
};

/** Platform apps and a handful of stray ones stay in no project, as on a real fleet. */
export function exampleProjectOf(app: WorldApp): string | null {
  if (app.system) return null;
  return (
    (app.stack && PROJECT_OF_STACK[app.stack]) ||
    PROJECT_OF_SLUG[app.slug] ||
    null
  );
}
