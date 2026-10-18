/** The shape of an example app, how one is written, and the stacks they form. */
import { APPS, CLUSTER_ID } from './sandbox-world-core';
import { WorldClusterId } from './sandbox-world-topology-fleet';

export type WorldCategory =
  | 'database'
  | 'cache'
  | 'storage'
  | 'automation'
  | 'media'
  | 'monitoring'
  | 'web'
  | 'business'
  | 'infra';

export interface WorldApp {
  id: string;
  clusterId: WorldClusterId;
  /** The stack's key in WORLD_STACKS; absent for a standalone app. */
  stack?: string;
  slug: string;
  name: string;
  category: WorldCategory;
  system?: boolean;
  workload: 'deployment' | 'statefulset' | 'daemonset';
  exposure: 'public' | 'internal' | 'cluster';
  ramMb: number;
  cpuM: number;
  /** Replicas per server, by server name. */
  on: Record<string, number>;
  /** The same app on another cluster shares this. */
  group?: string;
  port?: number;
}

export interface WorldStack {
  key: string;
  name: string;
  primary: string;
}

const EXISTING = new Map<string, string>(APPS.map((a) => [a.slug, a.id]));

/** One example app, written positionally: sixty of them read best as a table. */
type WorldAppRow = [
  clusterId: WorldClusterId,
  stack: string | undefined,
  slug: string,
  name: string,
  category: WorldCategory,
  workload: WorldApp['workload'],
  exposure: WorldApp['exposure'],
  size: [ramMb: number, cpuM: number],
  on: Record<string, number>,
  extra?: Partial<WorldApp>,
];

export const worldApp = (...row: WorldAppRow): WorldApp => {
  const [
    clusterId,
    stack,
    slug,
    name,
    category,
    workload,
    exposure,
    size,
    on,
    extra = {},
  ] = row;
  return {
    id:
      clusterId === CLUSTER_ID && EXISTING.has(slug)
        ? EXISTING.get(slug)!
        : `example-app-${clusterId.slice(-1)}-${slug}`,
    clusterId,
    stack,
    slug,
    name,
    category,
    workload,
    exposure,
    ramMb: size[0],
    cpuM: size[1],
    on,
    ...extra,
  };
};

export const EU = CLUSTER_ID as WorldClusterId;
export const US: WorldClusterId = 'example-cluster-2';
export const ASIA: WorldClusterId = 'example-cluster-3';
export const CONTROL: WorldClusterId = 'example-cluster-4';
export const STAGING: WorldClusterId = 'example-cluster-5';

export const WORLD_STACKS: WorldStack[] = [
  { key: 'storefront', name: 'Storefront', primary: 'storefront' },
  { key: 'orders', name: 'Orders', primary: 'orders-api' },
  { key: 'auth', name: 'Auth', primary: 'auth' },
  { key: 'billing', name: 'Billing', primary: 'billing-api' },
  { key: 'search', name: 'Search', primary: 'search' },
  { key: 'cms', name: 'CMS', primary: 'cms' },
  { key: 'notifications', name: 'Notifications', primary: 'notify-api' },
  { key: 'analytics', name: 'Analytics', primary: 'plausible' },
  { key: 'bi', name: 'BI', primary: 'metabase' },
  { key: 'automation', name: 'Automation', primary: 'n8n' },
  { key: 'media', name: 'Media', primary: 'imgproxy' },
  { key: 'cache-queue', name: 'Cache & queue', primary: 'nats' },
  { key: 'storefront-us', name: 'Storefront US', primary: 'storefront' },
  { key: 'orders-us', name: 'Orders US', primary: 'orders-reader' },
  { key: 'edge-asia', name: 'Edge Asia', primary: 'edge-cache' },
  { key: 'staging-shop', name: 'Staging shop', primary: 'storefront' },
];
