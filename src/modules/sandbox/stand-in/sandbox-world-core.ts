/**
 * The vocabulary every part of the example world is built from.
 *
 * It lives on its own so that the sections cannot drift apart. A guest who
 * reads Providers, then Access, then Mail must come away with *one*
 * organisation: the same company, on the same zone, with the same people. Three
 * files each inventing their own names read as three broken sections rather
 * than as a demonstration — so the names are declared once, here, and imported.
 *
 * The rules the world is held to are written at the head of `sandbox-world.ts`.
 * The two that bite hardest in this file: nothing here is ever written to a
 * table, and no value that is shaped like a secret is invented, not even a
 * fake one.
 */

/**
 * The request's own query string, for the few builders that answer a window or
 * a filter. Declared here rather than beside the rules so a world file never
 * imports back from the list that imports it.
 */
export type SandboxStandInQuery = Record<string, unknown>;

export const SANDBOX_EXAMPLE_FLAG = 'sandboxExample';

type Example<T> = T & { sandboxExample: true };

export const mark = <T extends object>(value: T): Example<T> => ({
  ...value,
  sandboxExample: true as const,
});

export const minutesAgo = (now: number, minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

export const hoursAgo = (now: number, hours: number): string =>
  minutesAgo(now, hours * 60);

export const daysAgo = (now: number, days: number): string =>
  hoursAgo(now, days * 24);

export const inDays = (now: number, days: number): string =>
  new Date(now + days * 24 * 3_600_000).toISOString();

/** The one organisation the whole example world belongs to. */
export const ORG_NAME = 'Northwind Labs';
export const ZONE_NAME = 'northwind-labs.eu';
export const CLUSTER_ID = 'example-cluster-1';
export const CLUSTER_NAME = 'northwind-prod';

export const PROVIDER = 'hetzner';
export const REGION = 'fsn1';
export const REGION_NAME = 'Falkenstein, Germany';
export const NETWORK_RANGE = '10.10.0.0/16';
export const SUBNET_RANGE = '10.10.1.0/24';

/** Marked like everything else: nothing in this world goes out undeclared. */
export const EXAMPLE_REGION = mark({
  id: REGION,
  name: REGION_NAME,
  country: 'DE',
});

/** The three machines everything else in this world refers to. */
export const MACHINES = [
  {
    id: 'example-server-1',
    name: 'flui-edge-1',
    role: 'master',
    cpuCores: 4,
    ramMb: 8192,
    diskMb: 163_840,
    productName: 'CPX31',
    privateIp: '10.10.1.11',
    publicIp: '203.0.113.11',
  },
  {
    id: 'example-server-2',
    name: 'flui-worker-1',
    role: 'worker',
    cpuCores: 8,
    ramMb: 16_384,
    diskMb: 327_680,
    productName: 'CPX41',
    privateIp: '10.10.1.12',
    publicIp: '203.0.113.12',
  },
  {
    id: 'example-server-3',
    name: 'flui-worker-2',
    role: 'worker',
    cpuCores: 8,
    ramMb: 16_384,
    diskMb: 327_680,
    productName: 'CPX41',
    privateIp: '10.10.1.13',
    publicIp: '203.0.113.13',
  },
] as const;

/**
 * The people of the example organisation.
 *
 * Addresses are on the organisation's own zone, which exists nowhere — the same
 * reasoning as the RFC 5737 addresses on the machines above. They are shaped
 * like a small team because that is what the Access section is meant to
 * demonstrate: a handful of people with different reach, which no amount of
 * prose explains as well.
 */
export const PEOPLE = [
  {
    id: 'example-user-1',
    firstName: 'Marta',
    lastName: 'Keller',
    email: `marta.keller@${ZONE_NAME}`,
    title: 'Platform lead',
    identityRole: 'admin' as const,
  },
  {
    id: 'example-user-2',
    firstName: 'Tomas',
    lastName: 'Rieger',
    email: `tomas.rieger@${ZONE_NAME}`,
    title: 'Backend',
    identityRole: 'user' as const,
  },
  {
    id: 'example-user-3',
    firstName: 'Aisha',
    lastName: 'Ndiaye',
    email: `aisha.ndiaye@${ZONE_NAME}`,
    title: 'Frontend',
    identityRole: 'user' as const,
  },
  {
    id: 'example-user-4',
    firstName: 'Jonas',
    lastName: 'Berg',
    email: `jonas.berg@${ZONE_NAME}`,
    title: 'On call, read-only',
    identityRole: 'readonly' as const,
  },
] as const;

/**
 * The applications of the example organisation.
 *
 * The same four turn up as grant targets in Access, as senders in Mail and as
 * the thing a backup policy protects. Sections that name different applications
 * from one another read as broken.
 */
export const APPS = [
  {
    id: 'example-app-1',
    slug: 'storefront',
    name: 'Storefront',
    kind: 'application',
    project: 'commerce',
    tags: ['production'],
  },
  {
    id: 'example-app-2',
    slug: 'orders-api',
    name: 'Orders API',
    kind: 'application',
    project: 'commerce',
    tags: ['production'],
  },
  {
    id: 'example-app-3',
    slug: 'orders-db',
    name: 'Orders database',
    kind: 'database',
    project: 'commerce',
    tags: ['production', 'stateful'],
  },
  {
    id: 'example-app-4',
    slug: 'internal-tools',
    name: 'Internal tools',
    kind: 'application',
    project: 'platform',
    tags: ['staging'],
  },
] as const;
