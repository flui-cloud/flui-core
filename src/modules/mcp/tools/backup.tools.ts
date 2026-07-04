import { z } from 'zod';
import { CreateBackupJobDto } from '../../backups/dto/create-backup-job.dto';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

/**
 * Backup control tools: read the backup posture, run an on-demand backup, and
 * pause/resume a policy's schedule. Creating destinations/policies and restoring
 * are config-heavy / high-blast operations left to the CLI + dashboard.
 */
export const BACKUP_TOOLS: ToolDef[] = [
  defineTool({
    name: 'backup_status',
    description:
      'Backup posture for the current user: policies, destinations, the most recent jobs and any alerts. Use it to answer "are my backups healthy / when did the last one run".',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.services.backupStatus.getStatus(ctx.user.userId),
  }),
  defineTool({
    name: 'backup_policy_list',
    description:
      "List the current user's backup policies (schedule, scope, retention, enabled/paused state). Find a policyId here to run, pause or resume it.",
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.services.backupPolicies.list(ctx.user.userId),
  }),
  defineTool({
    name: 'backup_run',
    description:
      'Trigger an on-demand backup run for a policy (in addition to its schedule). Get policyId from backup_policy_list. Returns the backup job.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: { policyId: z.string() },
    run: (args, ctx) => {
      const dto: CreateBackupJobDto = { policyId: args.policyId };
      return ctx.services.backupJobs.createOnDemand(ctx.user.userId, dto);
    },
  }),
  defineTool({
    name: 'backup_policy_pause',
    description:
      'Pause a backup policy: stops its scheduled runs. A database-class policy keeps shipping WAL for point-in-time recovery until it is deleted (pausing that would tear a hole in the recovery window). Get policyId from backup_policy_list.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: { policyId: z.string() },
    run: (args, ctx) => ctx.services.backupPolicies.pause(args.policyId),
  }),
  defineTool({
    name: 'backup_policy_resume',
    description:
      'Resume a paused backup policy: re-enables its schedule. Get policyId from backup_policy_list.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: { policyId: z.string() },
    run: (args, ctx) => ctx.services.backupPolicies.resume(args.policyId),
  }),
];
