/**
 * The example organisation's whole fleet, as the Topology page draws it.
 *
 * A small online shop: production, a staging copy of it, and the control
 * cluster Flui runs on. The production cluster is the one every other section
 * already describes: its machines are `MACHINES`, its first applications are
 * `APPS`, with the same ids, so nothing a guest opens from Topology lands on a
 * page that has never heard of it.
 *
 * An ordinary afternoon: modest traffic, every link inside its own cluster,
 * and one thing worth a look — the worker that keeps running into its memory
 * limit.
 */
import { ZONE_NAME } from './sandbox-world-core';
import { WorldClusterId, WorldServer } from './sandbox-world-topology-fleet';
import {
  CONTROL,
  PRODUCTION,
  STAGING,
  WorldApp,
} from './sandbox-world-topology-apps';
import {
  WORLD_APPS_PRODUCTION,
  WORLD_APPS_STAGING,
} from './sandbox-world-topology-apps-shop';
import { WORLD_APPS_CONTROL } from './sandbox-world-topology-apps-control';

export * from './sandbox-world-topology-fleet';
export * from './sandbox-world-topology-apps';

export const WORLD_APPS: WorldApp[] = [
  ...WORLD_APPS_PRODUCTION,
  ...WORLD_APPS_STAGING,
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
): WorldLink => ({
  from: key(clusterId, from),
  to: key(clusterId, to),
  source,
});

const host = (name: string) => `${name}.${ZONE_NAME}`;

export const WORLD_LINKS: WorldLink[] = [
  route(PRODUCTION, 'storefront', 13.7, 0.3, host('shop')),
  route(PRODUCTION, 'docs', 2.3, 0, host('docs')),
  route(PRODUCTION, 'umami', 6.4, 0.1, host('stats')),
  route(STAGING, 'storefront', 0.6, 0, host('staging.shop')),
  route(CONTROL, 'flui-web', 0.8, 0, host('flui')),
  route(CONTROL, 'flui-api', 1.9, 0.1, host('flui'), '/api'),
  route(CONTROL, 'zitadel', 0.7, 0, host('login')),

  uses(PRODUCTION, 'storefront', 'api', 'env-reference'),
  uses(PRODUCTION, 'api', 'postgres'),
  uses(PRODUCTION, 'api', 'redis'),
  uses(PRODUCTION, 'api', 'meilisearch'),
  uses(PRODUCTION, 'worker', 'postgres'),
  uses(PRODUCTION, 'worker', 'redis'),
  uses(PRODUCTION, 'umami', 'postgres'),
  uses(STAGING, 'storefront', 'api', 'env-reference'),
  uses(STAGING, 'api', 'postgres'),
  uses(CONTROL, 'flui-api', 'postgres', 'env-reference'),
  uses(CONTROL, 'flui-api', 'redis', 'env-reference'),
  uses(CONTROL, 'zitadel', 'postgres', 'env-reference'),
  uses(CONTROL, 'vmagent', 'vmsingle', 'env-reference'),
  uses(CONTROL, 'vmalert', 'vmsingle', 'env-reference'),
  uses(CONTROL, 'vmalert', 'alertmanager', 'env-reference'),
  uses(CONTROL, 'grafana', 'vmsingle', 'env-reference'),
  uses(CONTROL, 'grafana', 'loki', 'env-reference'),
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

/** Projects the example apps belong to: the shop, and the public sites around it. */
export const WORLD_PROJECTS = [
  { id: 'example-project-shop', name: 'Shop', slug: 'shop' },
  { id: 'example-project-website', name: 'Website', slug: 'website' },
] as const;

const WEBSITE = new Set(['docs', 'umami']);

/** Every user app is in a project, as Flui places them; platform apps are in none. */
export function exampleProjectOf(app: WorldApp): string | null {
  if (app.system) return null;
  return WEBSITE.has(app.slug)
    ? 'example-project-website'
    : 'example-project-shop';
}

/** The namespace an app runs in: its project's, or the platform's own. */
export function exampleNamespaceOf(app: WorldApp): string {
  if (app.namespace) return app.namespace;
  const project = WORLD_PROJECTS.find((p) => p.id === exampleProjectOf(app))!;
  return `p-${project.slug}`;
}
