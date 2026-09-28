import { z } from 'zod';
import { CreateBackupJobDto } from '../../backups/dto/create-backup-job.dto';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

/** Path-segment safety: an id from a model is input, not a literal. */
const enc = encodeURIComponent;

/**
 * Backup control tools: read the backup posture, list backups, run an
 * on-demand backup, pause/resume a policy's schedule, and restore a database
 * backup into a NEW database (nothing existing is touched). Creating
 * destinations/policies and restoring over existing resources are
 * config-heavy / high-blast operations left to the CLI + dashboard.
 */
export const BACKUP_TOOLS: ToolDef[] = [
  defineTool({
    name: 'backup_status',
    routes: ['GET /backups/status'],
    description:
      'Backup posture for the current user: policies, destinations, the most recent jobs and any alerts. Use it to answer "are my backups healthy / when did the last one run".',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/backups/status'),
  }),
  defineTool({
    name: 'backup_coverage',
    routes: ['GET /fleet/backup-protection'],
    description:
      'Which applications a recent backup would bring back, across every cluster (or one, with clusterId). Each application says whether it holds data (database, persistent volume or stateful), its coverage (protected | pending | to_verify | unprotected), the reason, the policy that covers it and the last successful backup. Protected means a covering policy succeeded within two runs of its schedule; `alarm` is true for a user application holding data that is unprotected. Use it to answer "which of my apps have no backup". Applications come first when they alarm, databases first among them.',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: { clusterId: z.string().optional() },
    run: (args, ctx) =>
      ctx.api.get('/fleet/backup-protection', { clusterId: args.clusterId }),
  }),
  defineTool({
    name: 'backup_policy_list',
    routes: ['GET /backup-policies'],
    description:
      "List the current user's backup policies (schedule, scope, retention, enabled/paused state). Find a policyId here to run, pause or resume it.",
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/backup-policies'),
  }),
  defineTool({
    name: 'backup_run',
    routes: ['POST /backup-jobs'],
    description:
      'Trigger an on-demand backup run for a policy (in addition to its schedule). Get policyId from backup_policy_list. Returns the backup job.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: { policyId: z.string() },
    run: (args, ctx) => {
      const dto: CreateBackupJobDto = { policyId: args.policyId };
      return ctx.api.post('/backup-jobs', dto);
    },
  }),
  defineTool({
    name: 'backup_policy_pause',
    routes: ['POST /backup-policies/:id/pause'],
    description:
      'Pause a backup policy: stops its scheduled runs. A database-class policy keeps shipping WAL for point-in-time recovery until it is deleted (pausing that would tear a hole in the recovery window). Get policyId from backup_policy_list.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: { policyId: z.string() },
    run: (args, ctx) =>
      ctx.api.post(`/backup-policies/${enc(args.policyId)}/pause`, {}),
  }),
  defineTool({
    name: 'backup_policy_resume',
    routes: ['POST /backup-policies/:id/resume'],
    description:
      'Resume a paused backup policy: re-enables its schedule. Get policyId from backup_policy_list.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: { policyId: z.string() },
    run: (args, ctx) =>
      ctx.api.post(`/backup-policies/${enc(args.policyId)}/resume`, {}),
  }),
  defineTool({
    name: 'backup_destination_set_cost',
    routes: ['PATCH /backup-destinations/:id/cost'],
    description:
      'Set what a backup destination costs, in euro cents per GB per month (e.g. 1.606), so backup cost estimates use it. Pass null to go back to the published list price, when Flui has one for the provider. Get destinationId from backup_status.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: {
      destinationId: z.string(),
      costPerGbMonthCents: z.number().min(0).nullable(),
    },
    run: (args, ctx) =>
      ctx.api.patch(`/backup-destinations/${enc(args.destinationId)}/cost`, {
        costPerGbMonthCents: args.costPerGbMonthCents,
      }),
  }),
  defineTool({
    name: 'backup_list',
    routes: ['GET /backup-artifacts'],
    description:
      'List the backups of one application (pass applicationId — it may be a database that no longer exists) or of one cluster (pass clusterId). Each backup has an id; a database backup id is what backup_restore_database takes.',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {
      applicationId: z.string().optional(),
      clusterId: z.string().optional(),
    },
    run: (args, ctx) => {
      const query = args.applicationId
        ? `applicationId=${enc(args.applicationId)}`
        : `clusterId=${enc(args.clusterId ?? '')}`;
      return ctx.api.get(`/backup-artifacts?${query}`);
    },
  }),
  defineTool({
    name: 'backup_restore_database',
    routes: ['POST /backup-artifacts/:id/restore-database'],
    description:
      'Restore a database backup (id from backup_list) into a NEW database named `name` — also when the original database was deleted. Omit `at` for everything that was archived, or pass an ISO-8601 instant. clusterId defaults to the original cluster while it exists. Nothing existing is modified.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: {
      artifactId: z.string(),
      name: z.string(),
      at: z.string().optional(),
      clusterId: z.string().optional(),
    },
    run: (args, ctx) =>
      ctx.api.post(
        `/backup-artifacts/${enc(args.artifactId)}/restore-database`,
        {
          name: args.name,
          ...(args.at ? { recoveryTargetTime: args.at } : {}),
          ...(args.clusterId ? { clusterId: args.clusterId } : {}),
        },
      ),
  }),
];
