import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { coerceBoolean, defineTool, ToolDef } from './mcp-tool.util';

/** Scheduled-job (cron) tools: list/create/update are write, delete is destructive. */
export const CRON_TOOLS: ToolDef[] = [
  defineTool({
    name: 'schedule_list',
    description:
      "List the scheduled jobs (cron) of an application. Each runs a command on the app's image + env on a cron schedule. Find the application id with app_list first.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.services.scheduledJobs.listForApp(args.id),
    forModel: (data) => {
      const jobs = (data as Array<Record<string, unknown>>) ?? [];
      return jobs.map((j) => ({
        name: j.name,
        schedule: j.schedule,
        enabled: j.enabled,
        command: j.command,
        lastScheduleTime: j.lastScheduleTime,
      }));
    },
  }),
  defineTool({
    name: 'schedule_create',
    description:
      "Create a scheduled job (cron) on an application. Runs `command` via /bin/sh -c on the app's image + env, on the given cron expression (5 fields). Overlapping runs are skipped by default (concurrency=Forbid). name must be lowercase alphanumeric + dashes.",
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      name: z.string(),
      schedule: z.string(),
      command: z.string(),
      timezone: z.string().optional(),
      concurrencyPolicy: z.enum(['Allow', 'Forbid', 'Replace']).optional(),
      enabled: coerceBoolean().optional(),
    },
    run: (args, ctx) =>
      ctx.services.scheduledJobs.create(args.id, {
        name: args.name,
        schedule: args.schedule,
        command: args.command,
        timezone: args.timezone,
        concurrencyPolicy: args.concurrencyPolicy,
        enabled: args.enabled,
      }),
  }),
  defineTool({
    name: 'schedule_trigger',
    description:
      'Trigger a scheduled job now, independently of its cron timing. Creates a one-off run. Returns the run (Job) name.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string(), name: z.string() },
    run: (args, ctx) => ctx.services.scheduledJobs.trigger(args.id, args.name),
  }),
  defineTool({
    name: 'schedule_runs',
    description:
      'List the recent runs of a scheduled job with their status (Succeeded/Failed/Running). History depth follows the CronJob retention limits.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string(), name: z.string() },
    run: (args, ctx) => ctx.services.scheduledJobs.listRuns(args.id, args.name),
  }),
  defineTool({
    name: 'schedule_delete',
    description:
      'Delete a scheduled job (cron) from an application by its name. Destructive.',
    scope: MCP_SCOPE.APP_DESTRUCTIVE,
    inputSchema: { id: z.string(), name: z.string() },
    run: async (args, ctx) => {
      await ctx.services.scheduledJobs.remove(args.id, args.name);
      return { deleted: true, name: args.name };
    },
  }),
];
