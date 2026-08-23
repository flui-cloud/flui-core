import { z } from 'zod';
import { CreateAppMigrationDto } from '../../app-migration/dto/create-app-migration.dto';
import { CreateDbMigrationDto } from '../../db-lifecycle/dto/create-db-migration.dto';
import { CreateFullMigrationDto } from '../../full-migration/dto/create-full-migration.dto';
import { AppCutoverMode } from '../../app-migration/enums/app-migration.enum';
import {
  DbCutoverMode,
  DbMigrationMode,
} from '../../db-lifecycle/enums/db-migration.enum';
import {
  FullCutoverMode,
  FullStagingMode,
} from '../../full-migration/enums/full-migration.enum';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  coerceBoolean,
  defineTool,
  McpToolContext,
  startedOutcome,
  ToolDef,
} from './mcp-tool.util';

/** Path-segment safety: an id from a model is input, not a literal. */
const enc = encodeURIComponent;

/** The collection route each migration type is served from. */
const COLLECTION: Record<MigrationType, string> = {
  app: '/app-migrations',
  db: '/db-migrations',
  full: '/full-migrations',
};

type MigrationType = 'app' | 'db' | 'full';

interface StartedMigration {
  id: string;
  status: string;
  infrastructureOperationId?: string;
}

function normalizeType(value: string): MigrationType {
  const v = (value ?? '').toLowerCase();
  if (v === 'app' || v === 'db' || v === 'full') return v;
  throw new Error(`Invalid migration type "${value}". Allowed: app, db, full.`);
}

/** Case-insensitive optional enum match; throws a self-correcting message. */
function optEnum<T extends Record<string, string>>(
  field: string,
  value: string | undefined,
  enumObj: T,
): T[keyof T] | undefined {
  if (value === undefined || value === '') return undefined;
  const wanted = value.toLowerCase();
  const hit = Object.values(enumObj).find((v) => v === wanted);
  if (!hit) {
    throw new Error(
      `Invalid ${field} "${value}". Allowed: ${Object.values(enumObj).join(', ')}.`,
    );
  }
  return hit as T[keyof T];
}

/** Compact migration view — drops the heavy rewirePlan jsonb from full migrations. */
function migView(data: unknown): unknown {
  const m = data as Record<string, unknown>;
  return {
    id: m.id,
    status: m.status,
    cutoverMode: m.cutoverMode,
    stagingMode: m.stagingMode,
    srcAppId: m.srcAppId,
    appId: m.appId,
    dbAppId: m.dbAppId,
    dstAppId: m.dstAppId,
    mode: m.mode,
    targetClusterId: m.targetClusterId,
    dbMigrationId: m.dbMigrationId,
    appMigrationId: m.appMigrationId,
    error: m.errorMessage,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
  };
}

function listView(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(migView);
  const d = data as { app?: unknown[]; db?: unknown[]; full?: unknown[] };
  return {
    app: (d.app ?? []).map(migView),
    db: (d.db ?? []).map(migView),
    full: (d.full ?? []).map(migView),
  };
}

/**
 * The handle of a migration that has just been started. The status is the one
 * the create route answered with, not one read back a moment later: see
 * `startedOutcome`.
 */
function started(
  ctx: McpToolContext,
  type: MigrationType,
  entity: StartedMigration,
  label: string,
): unknown {
  const opId = entity.infrastructureOperationId;
  if (!opId) {
    return { migrationId: entity.id, type, status: entity.status };
  }
  return {
    migrationId: entity.id,
    type,
    ...startedOutcome(ctx, opId, entity.status, label),
  };
}

/**
 * Cross-cluster migration tools. `migrate_*` start a migration (async); the
 * lifecycle tools (cutover/abort/destroy-source) act on an existing one by
 * type + id. app/db legs of a full migration must be driven THROUGH the full
 * migration — driving a leg directly is refused server-side.
 */
export const MIGRATION_TOOLS: ToolDef[] = [
  defineTool({
    name: 'migrate_app',
    routes: ['POST /app-migrations'],
    description:
      "Move an application's workload (stateless) to another cluster. The app keeps its identity (same id / slug / URL); at cutover it is re-bound to the target cluster and its DNS is flipped. cutover='auto' flips as soon as the destination is Ready; cutover='manual' parks at READY until migration_cutover is called. Get srcAppId from app_list and targetClusterId from cluster_list. Returns an async operation — track it with operation_status or migration_get(type:'app').",
    scope: MCP_SCOPE.MIGRATION_WRITE,
    inputSchema: {
      srcAppId: z.string(),
      targetClusterId: z.string(),
      cutover: z.string().optional(),
    },
    run: async (args, ctx) => {
      const dto: CreateAppMigrationDto = {
        srcAppId: args.srcAppId,
        targetClusterId: args.targetClusterId,
        cutover: optEnum('cutover', args.cutover, AppCutoverMode),
      };
      const mig = await ctx.api.post<StartedMigration>('/app-migrations', dto);
      return started(ctx, 'app', mig, `Migrate app ${args.srcAppId}`);
    },
  }),
  defineTool({
    name: 'migrate_db',
    routes: ['POST /db-migrations'],
    description:
      "Move a managed Postgres to another cluster. mode='live' replicates then cuts over with the source alive; mode='restore' rebuilds from the off-provider backup repo (DR, source may be gone) and accepts recoveryTargetTime (ISO-8601) for point-in-time. The destination gets a FRESH identity (host/db/user/password). cutover='manual' parks at SYNCED. srcAppId is the managed-Postgres app id (app_list, kind=DATABASE). Returns an async operation.",
    scope: MCP_SCOPE.MIGRATION_WRITE,
    inputSchema: {
      srcAppId: z.string(),
      targetClusterId: z.string(),
      mode: z.string().optional(),
      cutover: z.string().optional(),
      displayName: z.string().optional(),
      recoveryTargetTime: z.string().optional(),
      verifyRowCounts: coerceBoolean().optional(),
    },
    run: async (args, ctx) => {
      const dto: CreateDbMigrationDto = {
        srcAppId: args.srcAppId,
        targetClusterId: args.targetClusterId,
        mode: optEnum('mode', args.mode, DbMigrationMode),
        cutover: optEnum('cutover', args.cutover, DbCutoverMode),
        displayName: args.displayName,
        recoveryTargetTime: args.recoveryTargetTime,
        verifyRowCounts: args.verifyRowCounts,
      };
      const mig = await ctx.api.post<StartedMigration>('/db-migrations', dto);
      return started(ctx, 'db', mig, `Migrate database ${args.srcAppId}`);
    },
  }),
  defineTool({
    name: 'migrate_full',
    routes: ['POST /full-migrations'],
    description:
      "Move a consumer app TOGETHER with its managed Postgres in one orchestrated cutover: the DB replicates, the app is staged on the target, then both cut over together and the app's DB connection is rewired to the new database. appId = the consumer app, dbAppId = its managed-Postgres app (both on the source cluster). staging='live-fenced' stages the app at full replicas against the read-only destination DB to shrink the write pause (the app must boot with no write-migrations-on-start and no background workers with external side-effects); 'scaled-down' (default) is the safe choice. cutover='manual' parks at READY. Returns an async operation.",
    scope: MCP_SCOPE.MIGRATION_WRITE,
    inputSchema: {
      appId: z.string(),
      dbAppId: z.string(),
      targetClusterId: z.string(),
      cutover: z.string().optional(),
      staging: z.string().optional(),
    },
    run: async (args, ctx) => {
      const dto: CreateFullMigrationDto = {
        appId: args.appId,
        dbAppId: args.dbAppId,
        targetClusterId: args.targetClusterId,
        cutover: optEnum('cutover', args.cutover, FullCutoverMode),
        stagingMode: optEnum('staging', args.staging, FullStagingMode),
      };
      const mig = await ctx.api.post<StartedMigration>('/full-migrations', dto);
      return started(ctx, 'full', mig, `Migrate app+db ${args.appId}`);
    },
  }),
  defineTool({
    name: 'migration_list',
    routes: [
      'GET /app-migrations',
      'GET /db-migrations',
      'GET /full-migrations',
    ],
    description:
      'List migrations for the current user. Optional type filter (app | db | full); omit to get all three grouped. Use this to find a migration id and its current status.',
    scope: MCP_SCOPE.MIGRATION_READ,
    inputSchema: { type: z.string().optional() },
    // Three independent reads of three collections, in parallel, exactly as
    // in process: nothing writes, and no ordering between them means anything.
    run: async (args, ctx) => {
      if (args.type === undefined || args.type === '') {
        const [app, db, full] = await Promise.all([
          ctx.api.get(COLLECTION.app),
          ctx.api.get(COLLECTION.db),
          ctx.api.get(COLLECTION.full),
        ]);
        return { app, db, full };
      }
      return ctx.api.get(COLLECTION[normalizeType(args.type)]);
    },
    forModel: listView,
  }),
  defineTool({
    name: 'migration_get',
    routes: [
      'GET /app-migrations/:id',
      'GET /db-migrations/:id',
      'GET /full-migrations/:id',
    ],
    description:
      'Get one migration by type (app | db | full) + id: its status, cutover mode and any error. Use it to check whether a migration is READY/SYNCED (needs a manual cutover) or has COMPLETED/FAILED.',
    scope: MCP_SCOPE.MIGRATION_READ,
    inputSchema: { type: z.string(), id: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`${COLLECTION[normalizeType(args.type)]}/${enc(args.id)}`),
    forModel: migView,
  }),
  defineTool({
    name: 'migration_cutover',
    routes: [
      'POST /app-migrations/:id/cutover',
      'POST /db-migrations/:id/cutover',
      'POST /full-migrations/:id/cutover',
    ],
    description:
      'Fire the cutover of a migration parked in manual mode (app/full at READY, db at SYNCED). type is app | db | full; for a full migration this promotes the DB and flips the app together. Refused for a leg of a full migration — drive the full migration instead.',
    scope: MCP_SCOPE.MIGRATION_WRITE,
    inputSchema: { type: z.string(), id: z.string() },
    run: (args, ctx) =>
      ctx.api.post(
        `${COLLECTION[normalizeType(args.type)]}/${enc(args.id)}/cutover`,
        {},
      ),
  }),
  defineTool({
    name: 'migration_abort',
    routes: [
      'DELETE /app-migrations/:id',
      'DELETE /db-migrations/:id',
      'DELETE /full-migrations/:id',
    ],
    description:
      'Abort a migration BEFORE cutover: tears the destination (and replication link) down; the source is untouched. type is app | db | full. Refused once the point of no return (DB promote) is passed — resume the cutover instead. Destructive.',
    scope: MCP_SCOPE.MIGRATION_DESTRUCTIVE,
    inputSchema: { type: z.string(), id: z.string() },
    run: (args, ctx) =>
      ctx.api.delete(`${COLLECTION[normalizeType(args.type)]}/${enc(args.id)}`),
  }),
  defineTool({
    name: 'migration_destroy_source',
    // Two, not three: a db migration has no destroy-source step and the body
    // below refuses it before any call is made, so `POST /db-migrations/:id/
    // destroy-source` was a declaration of a route that does not exist. It
    // matched no handler, which made it invisible to every check that reads
    // these declarations.
    routes: [
      'POST /app-migrations/:id/destroy-source',
      'POST /full-migrations/:id/destroy-source',
    ],
    description:
      'After a COMPLETED migration, tear down the drained SOURCE workload to reclaim its capacity. type is app | full (a db migration has no destroy-source step). Irreversible. Destructive.',
    scope: MCP_SCOPE.MIGRATION_DESTRUCTIVE,
    inputSchema: { type: z.string(), id: z.string() },
    run: (args, ctx) => {
      const type = normalizeType(args.type);
      if (type === 'db') {
        throw new Error(
          'A db migration has no destroy-source step (the source database is left fenced, not torn down).',
        );
      }
      return ctx.api.post(
        `${COLLECTION[type]}/${enc(args.id)}/destroy-source`,
        {},
      );
    },
  }),
];
