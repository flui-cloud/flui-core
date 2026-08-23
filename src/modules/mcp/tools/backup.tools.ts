import { z } from 'zod';
import { CreateBackupJobDto } from '../../backups/dto/create-backup-job.dto';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

/** Path-segment safety: an id from a model is input, not a literal. */
const enc = encodeURIComponent;

/**
 * Backup control tools: read the backup posture, run an on-demand backup, and
 * pause/resume a policy's schedule. Creating destinations/policies and restoring
 * are config-heavy / high-blast operations left to the CLI + dashboard.
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
];
