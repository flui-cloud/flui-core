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
  /** Where a platform app runs; user apps run in their project's namespace. */
  namespace?: 'flui-system' | 'flui-control';
  workload: 'deployment' | 'statefulset' | 'daemonset';
  exposure: 'public' | 'internal' | 'cluster';
  ramMb: number;
  /** Twice the request when absent. */
  limitMb?: number;
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

/** One example app, written positionally: a list of them reads best as a table. */
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

export const PRODUCTION = CLUSTER_ID as WorldClusterId;
export const STAGING: WorldClusterId = 'example-cluster-2';
export const CONTROL: WorldClusterId = 'example-cluster-3';

/** The shop's own code, deployed together from one manifest; its services are catalogue apps beside it. */
export const WORLD_STACKS: WorldStack[] = [
  { key: 'shop', name: 'Shop', primary: 'storefront' },
  { key: 'shop-staging', name: 'Shop', primary: 'storefront' },
];
