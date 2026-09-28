jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { DATA_DOOR_KEY } from './decorators/data-door.decorator';
import { CacheConsoleController } from '../database-console/controllers/cache-console.controller';
import { DbBackupController } from '../database-console/controllers/db-backup.controller';
import { DbConsoleController } from '../database-console/controllers/db-console.controller';
import { DbDiskController } from '../database-console/controllers/db-disk.controller';
import { DbPitrController } from '../database-console/controllers/db-pitr.controller';
import { DocumentConsoleController } from '../database-console/controllers/document-console.controller';
import { FulltextConsoleController } from '../database-console/controllers/fulltext-console.controller';
import { KafkaConsoleController } from '../database-console/controllers/kafka-console.controller';
import { KvConsoleController } from '../database-console/controllers/kv-console.controller';
import { MessagingConsoleController } from '../database-console/controllers/messaging-console.controller';
import { ObjectStoreConsoleController } from '../database-console/controllers/object-store-console.controller';
import { SearchConsoleController } from '../database-console/controllers/search-console.controller';
import { SecretsConsoleController } from '../database-console/controllers/secrets-console.controller';
import { SystemDbController } from '../database-console/controllers/system-db.controller';
import { ApplicationLogsController } from '../observability/controllers/application-logs.controller';
import { ServerMetricsController } from '../observability/controllers/server-metrics.controller';
import { ScheduledJobsController } from '../applications/controllers/scheduled-jobs.controller';
import { InfrastructureOperationsController } from '../infrastructure/operations/infrastructure-operations.controller';
import { PlatformComponentsController } from '../infrastructure/platform-components/controllers/platform-components.controller';
import { CrashDiagnosesController } from '../scaling/controllers/crash-diagnoses.controller';
import { PodDebugController } from '../scaling/controllers/pod-debug.controller';
import { VariablesController } from '../applications/controllers/variables.controller';
import { AppBuildsController } from '../app-builds/app-builds.controller';
import { StandaloneBuildsController } from '../app-builds/controllers/standalone-builds.controller';
import { RestoreJobsController } from '../backups/controllers/restore-jobs.controller';
import { BackupArtifactsController } from '../backups/controllers/backup-artifacts.controller';
import { ApplicationSnapshotsController } from '../applications/controllers/application-snapshots.controller';
import { DbLifecycleController } from '../db-lifecycle/controllers/db-lifecycle.controller';
import { DbMigrationController } from '../db-lifecycle/controllers/db-migration.controller';
import { AppMigrationController } from '../app-migration/controllers/app-migration.controller';
import { FullMigrationController } from '../full-migration/controllers/full-migration.controller';
import { ClustersController } from '../infrastructure/clusters/clusters.controller';
import { AdoptionController } from '../adoption/adoption.controller';
import { ServersController } from '../infrastructure/servers/servers.controller';
import { BackupPoliciesController } from '../backups/controllers/backup-policies.controller';
import { BackupDestinationsController } from '../backups/controllers/backup-destinations.controller';
import { QuickSetupController } from '../backups/controllers/quick-setup.controller';
import { BackupJobsController } from '../backups/controllers/backup-jobs.controller';
import { GatewayController } from '../applications/controllers/gateway.controller';
import { ClusterDnsZoneController } from '../dns/controllers/cluster-dns-zone.controller';
import { DnsZoneController } from '../dns/controllers/dns-zone.controller';
import { HetznerObjectStorageConnectionController } from '../providers/implementations/hetzner/object-storage/hetzner-object-storage-connection.controller';
import { ManagementController } from '../management/controllers/management.controller';
import { MailConnectionsController } from '../mail/controllers/mail-connections.controller';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { IAM_PERMISSION } from './constants/iam-permissions';

type Controller = Type<unknown>;

function isDoor(controller: Controller, method: string): boolean {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  if (typeof handler !== 'function') {
    throw new Error(`${controller.name}.${method} does not exist`);
  }
  return (
    Reflect.getMetadata(DATA_DOOR_KEY, handler) === true ||
    Reflect.getMetadata(DATA_DOOR_KEY, controller) === true
  );
}

function routesOf(controller: Controller): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => {
    const fn = (controller.prototype as Record<string, unknown>)[name];
    return (
      typeof fn === 'function' &&
      Reflect.getMetadata(METHOD_METADATA, fn) !== undefined
    );
  });
}

const WHOLE_CONTROLLERS: Controller[] = [
  CacheConsoleController,
  DbBackupController,
  DbConsoleController,
  DbDiskController,
  DbPitrController,
  DocumentConsoleController,
  FulltextConsoleController,
  KafkaConsoleController,
  KvConsoleController,
  MessagingConsoleController,
  ObjectStoreConsoleController,
  SearchConsoleController,
  SecretsConsoleController,
  SystemDbController,
  PodDebugController,
  RestoreJobsController,
  BackupArtifactsController,
  DbLifecycleController,
];

const DOOR_ROUTES: [Controller, string][] = [
  [ApplicationLogsController, 'lokiDebug'],
  [ApplicationLogsController, 'logSources'],
  [ApplicationLogsController, 'getAppLogs'],
  [ApplicationLogsController, 'getApplicationLogs'],
  [ApplicationLogsController, 'getAppLogVolume'],
  [ApplicationLogsController, 'getApplicationLogVolume'],
  [ServerMetricsController, 'getClusterLogs'],
  [ServerMetricsController, 'getClusterErrorLogs'],
  [ScheduledJobsController, 'runs'],
  [ScheduledJobsController, 'runLogs'],
  [InfrastructureOperationsController, 'downloadLog'],
  [InfrastructureOperationsController, 'readLogChunk'],
  [PlatformComponentsController, 'getPodLogs'],
  [CrashDiagnosesController, 'list'],
  [CrashDiagnosesController, 'getOne'],
  [VariablesController, 'getAppVariables'],
  [VariablesController, 'upsertAppVariables'],
  [VariablesController, 'listClusterVariables'],
  [VariablesController, 'getClusterVariables'],
  [VariablesController, 'upsertClusterVariables'],
  [AppBuildsController, 'listBuilds'],
  [AppBuildsController, 'getLatestBuild'],
  [AppBuildsController, 'getBuild'],
  [AppBuildsController, 'refreshBuild'],
  [StandaloneBuildsController, 'getBuild'],
  [ApplicationSnapshotsController, 'restoreSnapshot'],
  [ApplicationSnapshotsController, 'swapVolume'],
  [ApplicationSnapshotsController, 'createBackup'],
  [AppMigrationController, 'create'],
  [AppMigrationController, 'cutover'],
  [AppMigrationController, 'destroySource'],
  [FullMigrationController, 'create'],
  [FullMigrationController, 'cutover'],
  [FullMigrationController, 'destroySource'],
  [DbMigrationController, 'create'],
  [DbMigrationController, 'cutover'],
  [ClustersController, 'recoverAccess'],
  [ClustersController, 'rebuildPlan'],
  [ClustersController, 'rebuild'],
  [ServersController, 'getConsoleOutput'],
  [AdoptionController, 'issueToken'],
  [ScheduledJobsController, 'list'],
  [GatewayController, 'listRoutes'],
  [GatewayController, 'compiled'],
  ...COPY_OUT_AND_REPOINT_DOORS(),
];

/**
 * Doors that are not reads: a machine joining the cluster as a worker, a
 * backup choosing what is copied and where to, a domain or issuer pointed
 * elsewhere. Each also asks `cluster:manage`, so that `data:access` carried by
 * a read-only credential never opens them on its own.
 */
function COPY_OUT_AND_REPOINT_DOORS(): [Controller, string][] {
  return [
    [ClustersController, 'issueJoinToken'],
    [ClustersController, 'registerByosNode'],
    [BackupPoliciesController, 'create'],
    [BackupPoliciesController, 'enableDatabase'],
    [BackupPoliciesController, 'setPlatformConfig'],
    [BackupDestinationsController, 'create'],
    [QuickSetupController, 'start'],
    [ClusterDnsZoneController, 'assignZone'],
    [ClusterDnsZoneController, 'updatePrimaryCertConfig'],
    [ClusterDnsZoneController, 'updateCertConfig'],
    [ClusterDnsZoneController, 'configureIssuer'],
    [ClusterDnsZoneController, 'configureDnsSecret'],
    [ClusterDnsZoneController, 'configureDnsIssuers'],
    [ClusterDnsZoneController, 'configureIssuerByType'],
    [ClusterDnsZoneController, 'removeZone'],
    [ClusterDnsZoneController, 'removeAssignment'],
    [DnsZoneController, 'createZone'],
    [DnsZoneController, 'deleteZone'],
    [ClusterDnsZoneController, 'configureSystemIngress'],
    [ClusterDnsZoneController, 'syncAuthDomain'],
    [ClusterDnsZoneController, 'syncApiDomain'],
    [ClusterDnsZoneController, 'syncWebDomain'],
    [HetznerObjectStorageConnectionController, 'connect'],
    [ManagementController, 'configureProvider'],
    [ManagementController, 'rotateProviderCredentials'],
    [ManagementController, 'enableProvider'],
    [MailConnectionsController, 'connect'],
    [MailConnectionsController, 'activate'],
    [MailConnectionsController, 'publishFor'],
    [MailConnectionsController, 'retryWebhook'],
  ];
}

const NOT_DOORS: [Controller, string][] = [
  [BackupJobsController, 'create'],
  [BackupPoliciesController, 'pause'],
  [BackupPoliciesController, 'resume'],
  [BackupPoliciesController, 'list'],
  [BackupDestinationsController, 'test'],
  [BackupDestinationsController, 'setCost'],
  [GatewayController, 'status'],
  [ClusterDnsZoneController, 'reconcileAssignment'],
  [ManagementController, 'updateProviderRegions'],
  [ManagementController, 'updateProviderCredentialsExpiry'],
  [HetznerObjectStorageConnectionController, 'status'],
];

describe('data doors carry @DataDoor', () => {
  it.each(
    WHOLE_CONTROLLERS.flatMap((c) =>
      routesOf(c).map((m) => [`${c.name}.${m}`, c, m] as const),
    ),
  )('%s', (_label, controller, method) => {
    expect(isDoor(controller, method)).toBe(true);
  });

  it.each(DOOR_ROUTES.map(([c, m]) => [`${c.name}.${m}`, c, m] as const))(
    '%s',
    (_label, controller, method) => {
      expect(isDoor(controller, method)).toBe(true);
    },
  );

  it.each(
    COPY_OUT_AND_REPOINT_DOORS().map(
      ([c, m]) => [`${c.name}.${m}`, c, m] as const,
    ),
  )('%s also asks cluster:manage', (_label, controller, method) => {
    const handler = (controller.prototype as Record<string, unknown>)[
      method
    ] as object;
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler)).toBe(
      IAM_PERMISSION.CLUSTER_MANAGE,
    );
  });

  it.each(NOT_DOORS.map(([c, m]) => [`${c.name}.${m}`, c, m] as const))(
    '%s is not a door',
    (_label, controller, method) => {
      expect(isDoor(controller, method)).toBe(false);
    },
  );
});

/**
 * A route whose path says it hands out data and that is not marked as a door.
 *
 * Heuristic by design: a name is not proof, which is why an exemption names
 * its reason. A new route matching the pattern turns this red until it is
 * either marked or argued for here.
 */
const DATA_PATH =
  /[/-](logs?|console|connection-info|secrets\/read|dump|download|restore|shell|db\/query|query)\b/;

/** `VERB /path` → why a route matching the pattern is not a data door. */
const EXEMPT: Record<string, string> = {};

const EXEMPT_DIRS = [
  // Covered by access.controller.authz.spec.ts and terminal-target.resolver.spec.ts.
  join('modules', 'access'),
  join('modules', 'terminal'),
];

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function pathsOf(meta: unknown): string[] {
  if (meta === undefined) return [''];
  return (Array.isArray(meta) ? meta : [meta]).map(String);
}

interface LookalikeRoute {
  key: string;
  handler: string;
  door: boolean;
}

function lookalikeRoutes(): LookalikeRoute[] {
  const found: LookalikeRoute[] = [];
  const src = join(__dirname, '..', '..');
  for (const file of controllerFiles(join(src, 'modules'))) {
    if (EXEMPT_DIRS.some((d) => file.includes(`/${d}/`))) continue;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const controller = exported as Controller;
      const base = Reflect.getMetadata(PATH_METADATA, controller);
      if (base === undefined) continue;
      for (const method of routesOf(controller)) {
        const handler = (controller.prototype as Record<string, unknown>)[
          method
        ] as object;
        const verb = RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, handler) as number
        ] as string;
        for (const b of pathsOf(base)) {
          for (const p of pathsOf(
            Reflect.getMetadata(PATH_METADATA, handler),
          )) {
            const path = `/${b}/${p}`.replace(/\/+/g, '/').replace(/\/$/, '');
            if (!DATA_PATH.test(path)) continue;
            found.push({
              key: `${verb} ${path}`,
              handler: `${controller.name}.${method}`,
              door: isDoor(controller, method),
            });
          }
        }
      }
    }
  }
  return found;
}

describe('routes that look like data doors', () => {
  const routes = lookalikeRoutes();

  it('finds the known doors, so the scan is not silently empty', () => {
    expect(routes.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        'POST /applications/:id/db/query',
        'POST /applications/:id/secrets/read',
        'GET /observability/applications/:id/logs',
      ]),
    );
  });

  it('are all marked or named in the exemption list', () => {
    const unmarked = routes
      .filter((r) => !r.door && !EXEMPT[r.key])
      .map((r) => `${r.key} (${r.handler})`);
    expect(unmarked).toEqual([]);
  });

  it('exempts only routes that exist and are still unmarked', () => {
    const stale = Object.keys(EXEMPT).filter(
      (key) => !routes.some((r) => r.key === key && !r.door),
    );
    expect(stale).toEqual([]);
  });
});
