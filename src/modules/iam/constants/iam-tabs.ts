import { IAM_PERMISSION, IamPermission } from './iam-permissions';

/**
 * The tabs of an application's detail view, and the permission each one needs on
 * *that* application.
 *
 * This is the per-resource counterpart of {@link SECTIONS}: a section decides
 * whether the sidebar entry exists at all, a tab decides what is reachable once
 * you are inside one app you can already read.
 *
 * Two rules kept this list from growing arbitrary:
 *
 * - A tab that renders a secret needs write, not read. `configuration` shows
 *   environment variables and `clients` shows connection strings; both are
 *   credentials, and read-only was never meant to mean "can read the password".
 * - A tab that only renders history or telemetry needs read. Somebody shown an
 *   application as a showcase piece should see how it behaves — that is the
 *   entire point of showing it — without being able to touch it.
 *
 * The list is a projection of permissions the API already enforces on the routes
 * behind each tab; it does not create authorisation, it reports it. Hiding a tab
 * is a courtesy to the reader, never the thing that stops the request.
 */
export const APP_TAB = {
  OVERVIEW: 'overview',
  MONITORING: 'monitoring',
  LOGS: 'logs',
  REVISIONS: 'revisions',
  BUILDS: 'builds',
  RELEASES: 'releases',
  DNS: 'dns',
  CLIENTS: 'clients',
  CONFIGURATION: 'configuration',
  RESOURCES: 'resources',
  SNAPSHOTS: 'snapshots',
  SCHEDULES: 'schedules',
  GATEWAY: 'gateway',
} as const;

export type AppTabKey = (typeof APP_TAB)[keyof typeof APP_TAB];

export const APP_TAB_PERMISSION: Record<AppTabKey, IamPermission> = {
  [APP_TAB.OVERVIEW]: IAM_PERMISSION.APP_READ,
  [APP_TAB.MONITORING]: IAM_PERMISSION.APP_READ,
  [APP_TAB.LOGS]: IAM_PERMISSION.APP_READ,
  [APP_TAB.REVISIONS]: IAM_PERMISSION.APP_READ,
  [APP_TAB.BUILDS]: IAM_PERMISSION.APP_READ,
  [APP_TAB.DNS]: IAM_PERMISSION.APP_READ,
  // Rolling back is a deploy, not an edit — an operator who may deploy but not
  // reconfigure still belongs here.
  [APP_TAB.RELEASES]: IAM_PERMISSION.APP_DEPLOY,
  [APP_TAB.CLIENTS]: IAM_PERMISSION.APP_WRITE,
  [APP_TAB.CONFIGURATION]: IAM_PERMISSION.APP_WRITE,
  [APP_TAB.RESOURCES]: IAM_PERMISSION.APP_WRITE,
  [APP_TAB.SNAPSHOTS]: IAM_PERMISSION.APP_WRITE,
  [APP_TAB.SCHEDULES]: IAM_PERMISSION.APP_WRITE,
  [APP_TAB.GATEWAY]: IAM_PERMISSION.APP_WRITE,
};

export const ALL_APP_TAB_KEYS: AppTabKey[] = Object.keys(
  APP_TAB_PERMISSION,
) as AppTabKey[];

/** The tabs a holder of `permissions` may open on the application they describe. */
export function tabsForPermissions(
  permissions: ReadonlySet<string>,
): AppTabKey[] {
  return ALL_APP_TAB_KEYS.filter((tab) =>
    permissions.has(APP_TAB_PERMISSION[tab]),
  );
}
