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
      'Backup posture for the current user: policies, destinations, the most recent jobs and any alerts, and per cluster whether every application is protected automatically (`protected`) and which volumes need a decision (`needsDecision`: databases Flui cannot back up consistently, or volumes the last copy refused). An alert that is about named resources lists them in `items` (id, name), e.g. the policies whose cluster no longer exists. Applications a person decided not to back up raise no alert and are not counted as pending; backup_coverage lists them as not_backed_up_by_choice. Use it to answer "are my backups healthy / when did the last one run".',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/backups/status'),
  }),
  defineTool({
    name: 'backup_coverage',
    routes: ['GET /fleet/backup-protection'],
    description:
      'Which applications a recent backup would bring back, across every cluster (or one, with clusterId). Each application says whether it holds data (database, persistent volume or stateful), its coverage (protected | pending | to_verify | unprotected | not_backed_up_by_choice), the reason, the policy that covers it and the last successful backup. `pending` says why protecting its cluster has not covered it yet (waiting | failed | needs_decision, with the reason, and `protectHelps`: false when a policy made by hand would not help, e.g. a database that is not running). Protected means a covering policy succeeded within two runs of its schedule; `alarm` is true for a user application holding data that is unprotected. `not_backed_up_by_choice` means a person decided it is not backed up (`decision`: note, decidedByName, decidedAt): it never alarms and is counted apart in `summary.notBackedUpByChoice`. Use it to answer "which of my apps have no backup". Applications come first when they alarm, databases first among them.',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: { clusterId: z.string().optional() },
    run: (args, ctx) =>
      ctx.api.get('/fleet/backup-protection', { clusterId: args.clusterId }),
  }),
  defineTool({
    name: 'backup_cluster_protection',
    routes: ['GET /clusters/:clusterId/backups/protection'],
    description:
      'How one cluster is protected (clusterId from cluster_list): whether every application gets a backup policy of its own, new ones included (`protected`), the destination and schedule it uses, whether a backup is taken before each deploy (`beforeDeploy`), what the last pass decided for each application (protected | already_protected | waiting | needs_decision | failed | skipped, with the reason — system, no_data or not_backed_up_by_choice — and the policy), and `needsDecision`: the volumes no backup can take consistently until a person chooses to stop the application during the copy or leave the volume out. Read-only.',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: { clusterId: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/clusters/${enc(args.clusterId)}/backups/protection`),
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
    name: 'backup_policy_activity',
    routes: ['GET /backup-policies/:id/activity'],
    description:
      "One backup policy's schedule and history: the schedule in words (UTC) with the next run and the previous due time, the health (ok | running | failed | missed | paused | never_run | on_demand) with a one-sentence detail and the last success, and the runs newest first (trigger, status, start, end, duration, size, encrypted, whether the copy is still stored, error). `missed` means a scheduled run was due and never started. Get policyId from backup_policy_list; limit defaults to 30, at most 100.",
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: {
      policyId: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    run: (args, ctx) =>
      ctx.api.get(`/backup-policies/${enc(args.policyId)}/activity`, {
        limit: args.limit,
      }),
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
    name: 'app_backup_before_deploy',
    routes: ['PUT /applications/:id/backup-before-deploy'],
    description:
      'Turn the backup before each deploy of an application on or off (id from app_list). On, every deploy first records a restore point of a continuous database (waited for, seconds) and starts a dump or a copy of the other volumes under the policies that already protect the application (not waited for). `required: true` fails the deploy when that backup cannot be taken. Returns what will be taken, and a warning when no policy protects the application yet.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      applicationId: z.string(),
      enabled: z.boolean(),
      required: z.boolean().optional(),
    },
    run: (args, ctx) =>
      ctx.api.put(
        `/applications/${enc(args.applicationId)}/backup-before-deploy`,
        {
          enabled: args.enabled,
          ...(args.required === undefined ? {} : { required: args.required }),
        },
      ),
  }),
  defineTool({
    name: 'app_backup_skip',
    routes: ['PUT /applications/:id/backup-decision'],
    description:
      'Record that an application is not to be backed up (id from app_list), with an optional note saying why; `undo: true` takes the decision back. Flui then stops counting it as unprotected, stops listing it as needing a backup, and protecting its cluster gives it no policy. Backups already taken and the policies naming it are left as they are (pause one with backup_policy_pause). A person approves this before it takes effect. Returns the decision, or null after an undo.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      applicationId: z.string(),
      note: z.string().max(500).optional(),
      undo: z.boolean().optional(),
    },
    run: (args, ctx) =>
      ctx.api.put(`/applications/${enc(args.applicationId)}/backup-decision`, {
        notBackedUp: !args.undo,
        ...(args.note && !args.undo ? { note: args.note } : {}),
      }),
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
    name: 'app_volume_backup_list',
    routes: ['GET /applications/:id/volume-backups'],
    description:
      "An application's volume backups, newest first (id from app_list). Each has an id, the volume, the engine (kopia | rclone | pvc-clone), when it was taken, what a restore writes back (logicalBytes) and what it added to the destination (uploadedBytes), whether it is still stored (present | expired | missing | unknown), whether it is kept by retention or until someone deletes it, and whether single files can be browsed (browsable). Read-only; restoring is left to the CLI and the dashboard.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { applicationId: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/applications/${enc(args.applicationId)}/volume-backups`),
  }),
  defineTool({
    name: 'app_volume_backup_browse',
    routes: ['GET /applications/:id/volume-backups/:backupId/files'],
    description:
      'List one directory inside a kopia volume backup (backupId from app_volume_backup_list, where browsable is true). `path` is relative to the volume root; omit it for the root. Each entry has name, type (directory | file | symlink), size, modifiedAt and mode. Nothing is restored and no file content is returned.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      applicationId: z.string(),
      backupId: z.string(),
      path: z.string().optional(),
    },
    run: (args, ctx) =>
      ctx.api.get(
        `/applications/${enc(args.applicationId)}/volume-backups/${enc(args.backupId)}/files`,
        args.path ? { path: args.path } : undefined,
      ),
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
  defineTool({
    name: 'backup_velero_footprint',
    routes: ['GET /clusters/:clusterId/backups/velero'],
    description:
      'What Velero, the cluster backup engine Flui no longer uses, left on one cluster (clusterId from cluster_list): whether anything is still installed (`installed`) and whether Flui installed it (`installedByFlui`), each component and whether it is present, its resource definitions and objects, the policies it ran (paused, they cannot run again), where the backups it wrote still are (`leftInDestinations`, never deleted by Flui), and a removal already running (`inFlightOperationId`). Read-only; to remove it call backup_velero_uninstall.',
    scope: MCP_SCOPE.BACKUP_READ,
    inputSchema: { clusterId: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`/clusters/${enc(args.clusterId)}/backups/velero`),
  }),
  defineTool({
    name: 'backup_velero_uninstall',
    routes: ['POST /clusters/:clusterId/backups/velero/uninstall'],
    description:
      'Remove Velero from one cluster (call backup_velero_footprint first and show the person what it lists): its controller, node agent, bucket credentials, cluster-wide binding, resource definitions and namespace. Only what Flui installed is removed; the backups it wrote stay in their destinations and nothing can restore them from Flui afterwards. Returns an operation id for operation_status (metadata.removed lists what went); while a removal runs the same id is returned, and running it again continues an unfinished one.',
    scope: MCP_SCOPE.BACKUP_WRITE,
    inputSchema: { clusterId: z.string() },
    run: (args, ctx) =>
      ctx.api.post(
        `/clusters/${enc(args.clusterId)}/backups/velero/uninstall`,
        {},
      ),
  }),
];
