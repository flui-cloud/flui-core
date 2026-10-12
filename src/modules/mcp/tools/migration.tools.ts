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
  coerceNumber,
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
    bridge: m.bridge,
    canResumeCutover: m.canResumeCutover,
    kind: m.kind,
    link: m.link,
    fence: m.fence,
    pooler: m.pooler,
    baseBackup: m.baseBackup,
    sourceWalCap: m.sourceWalCap,
    writePauseMs: m.writePauseMs,
    writePauseEndedBy: m.writePauseEndedBy,
    interruptionMs: m.interruptionMs,
    nextSteps: m.nextSteps,
    sourceDestroyedAt: m.sourceDestroyedAt,
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
      "Move an application to another cluster. The app keeps its identity (same id / slug / URL); at cutover it is re-bound to the target cluster and its DNS is flipped. An application with volumes is stopped at cutover while its volumes are copied through a backup destination (backupDestinationId, defaulting to the one protecting it or your only one), then starts on the destination; if the copy fails it starts again where it was. Tell the user about that interruption before starting. cutover='auto' cuts over as soon as the destination is staged; cutover='manual' parks at READY until migration_cutover is called. By default the source cluster keeps forwarding clients that still resolve it to the destination after the switch (status 'bridging' until migration_destroy_source); bridge=false moves DNS only. When the bridge cannot be used the migration moves DNS only and migration_get says why. Get srcAppId from app_list and targetClusterId from cluster_list. Returns an async operation — track it with operation_status or migration_get(type:'app').",
    scope: MCP_SCOPE.MIGRATION_WRITE,
    inputSchema: {
      srcAppId: z.string(),
      targetClusterId: z.string(),
      cutover: z.string().optional(),
      backupDestinationId: z.string().optional(),
      bridge: coerceBoolean().optional(),
    },
    run: async (args, ctx) => {
      const dto: CreateAppMigrationDto = {
        srcAppId: args.srcAppId,
        targetClusterId: args.targetClusterId,
        cutover: optEnum('cutover', args.cutover, AppCutoverMode),
        backupDestinationId: args.backupDestinationId,
        bridge: args.bridge,
      };
      const mig = await ctx.api.post<StartedMigration>('/app-migrations', dto);
      return started(ctx, 'app', mig, `Migrate app ${args.srcAppId}`);
    },
  }),
  defineTool({
    name: 'migrate_db',
    routes: ['POST /db-migrations'],
    description:
      "Move a managed Postgres to another cluster. mode='live' replicates then cuts over with the source alive; mode='restore' rebuilds from the off-provider backup repo (DR, source may be gone) and accepts recoveryTargetTime (ISO-8601) for point-in-time. A live move between two clusters on the Flui network is a private physical copy: the destination keeps the source's database name, user and password and only its address changes, and at cutover the source stops accepting connections. Otherwise (Flui network off, or mode='restore') the destination gets a fresh identity (host/db/user/password). migration_get says which kind ran. cutover='manual' parks at SYNCED. srcAppId is the managed-Postgres app id (app_list, kind=DATABASE). Returns an async operation.",
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
      "Move a consumer app TOGETHER with its managed Postgres in one orchestrated cutover: the DB replicates, the app is staged on the target, then both cut over together and the app's DB connection is rewired to the new database. appId = the consumer app, dbAppId = its managed-Postgres app (both on the source cluster). staging='live-fenced' stages the app at full replicas against the read-only destination DB to shrink the write pause (the app must boot with no write-migrations-on-start and no background workers with external side-effects); 'scaled-down' (default) is the safe choice. With a private physical copy, live-fenced and no volumes, the source cluster starts forwarding to the destination before writes stop, so reads keep working and writes pause only until the promote. backupDestinationId names the backup destination the app's volumes move through. cutover='manual' parks at READY. When the database has a connection pooler and the app uses its pooled address, the destination's pooler forwards to the source until the cutover, then both poolers hold new requests while transactions in flight finish (pauseDeadlineSeconds, 1-60, default 5), the database moves and the destination pooler lets them through: no write fails, writes wait. A transaction still open at the deadline is cut and its client must reconnect. Returns an async operation.",
    scope: MCP_SCOPE.MIGRATION_WRITE,
    inputSchema: {
      appId: z.string(),
      dbAppId: z.string(),
      targetClusterId: z.string(),
      cutover: z.string().optional(),
      staging: z.string().optional(),
      backupDestinationId: z.string().optional(),
      pauseDeadlineSeconds: coerceNumber(
        z.number().int().min(1).max(60),
      ).optional(),
    },
    run: async (args, ctx) => {
      const dto: CreateFullMigrationDto = {
        appId: args.appId,
        dbAppId: args.dbAppId,
        targetClusterId: args.targetClusterId,
        cutover: optEnum('cutover', args.cutover, FullCutoverMode),
        stagingMode: optEnum('staging', args.staging, FullStagingMode),
        backupDestinationId: args.backupDestinationId,
        pauseDeadlineSeconds: args.pauseDeadlineSeconds,
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
      'Get one migration by type (app | db | full) + id: its status, cutover mode, any error and, for app/full, the bridge block (mode, why it was skipped, state, closableAt, readyToClose, summary). For db/full: kind (logical | physical), and for a physical one the direct link (state, nodes, handshakeSeen), the source fence (appliedAt, fenceLsn, promoteIssuedAt, released), the copy (baseBackup.phase) and, with a pooled database, the pooler block (paused, pausedAt, resumedAt, deadlineMs, cut: the clients whose open transaction was cut at the deadline and how long they had held it). Measures: writePauseMs (db: fence to promote; full: fence to the moment writes reach the destination, writePauseEndedBy bridge | dns | promote | resume, resume meaning both poolers held the writes, which waited instead of failing, until the destination pooler let them through; promote meaning the bridge already forwarded before the fence and writes resumed when the destination was promoted) and interruptionMs (app/full: stopped while volumes moved). nextSteps lists what the user should do after a completed migration; relay it. Use it to check whether a migration is READY/SYNCED (needs a manual cutover), BRIDGING (served from the destination, the source still forwards) or has COMPLETED/FAILED.',
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
      'Fire the cutover of a migration parked in manual mode (app/full at READY, db at SYNCED), or resume an app or full cutover that lost its job, an app cutover that failed after the bridge opened, or a full migration in failed_forward (migration_get says canResumeCutover). type is app | db | full; for a full migration this promotes the DB and flips the app together. Refused for a leg of a full migration — drive the full migration instead. For a full migration with a pooled database, pauseDeadlineSeconds (1-60) replaces the pause deadline given at create.',
    scope: MCP_SCOPE.MIGRATION_WRITE,
    inputSchema: {
      type: z.string(),
      id: z.string(),
      pauseDeadlineSeconds: coerceNumber(
        z.number().int().min(1).max(60),
      ).optional(),
    },
    run: (args, ctx) => {
      const type = normalizeType(args.type);
      if (args.pauseDeadlineSeconds !== undefined && type !== 'full') {
        throw new Error(
          'pauseDeadlineSeconds applies to a full migration only.',
        );
      }
      return ctx.api.post(
        `${COLLECTION[type]}/${enc(args.id)}/cutover`,
        args.pauseDeadlineSeconds !== undefined
          ? { pauseDeadlineSeconds: args.pauseDeadlineSeconds }
          : {},
      );
    },
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
      "After the cutover (BRIDGING or COMPLETED), tear down the SOURCE workload to reclaim its capacity. An open bridge is closed first; the API refuses (409) while DNS answers cached before the switch may still point at the source — migration_get's bridge.closableAt says when that ends. Pass closeBridge=true only when the user accepts that clients still resolving the old cluster lose the application now. type is app | full (a db migration has no destroy-source step). Irreversible. Destructive.",
    scope: MCP_SCOPE.MIGRATION_DESTRUCTIVE,
    inputSchema: {
      type: z.string(),
      id: z.string(),
      closeBridge: coerceBoolean().optional(),
    },
    run: (args, ctx) => {
      const type = normalizeType(args.type);
      if (type === 'db') {
        throw new Error(
          'A db migration has no destroy-source step (the source database is left fenced, not torn down).',
        );
      }
      return ctx.api.post(
        `${COLLECTION[type]}/${enc(args.id)}/destroy-source`,
        args.closeBridge ? { closeBridge: true } : {},
      );
    },
  }),
];
