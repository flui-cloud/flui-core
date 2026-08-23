import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { coerceBoolean, defineTool, ToolDef } from './mcp-tool.util';

/** Path-segment safety: an id or a name from a model is input, not a literal. */
const enc = encodeURIComponent;

const schedules = (appId: string) => `/applications/${enc(appId)}/schedules`;

/** Scheduled-job (cron) tools: list/create/update are write, delete is destructive. */
export const CRON_TOOLS: ToolDef[] = [
  defineTool({
    name: 'schedule_list',
    routes: ['GET /applications/:id/schedules'],
    description:
      "List the scheduled jobs (cron) of an application. Each runs a command on the app's image + env on a cron schedule. Find the application id with app_list first.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.api.get(schedules(args.id)),
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
    routes: ['POST /applications/:id/schedules'],
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
      ctx.api.post(schedules(args.id), {
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
    routes: ['POST /applications/:id/schedules/:name/trigger'],
    description:
      'Trigger a scheduled job now, independently of its cron timing. Creates a one-off run. Returns the run (Job) name.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string(), name: z.string() },
    run: (args, ctx) =>
      ctx.api.post(`${schedules(args.id)}/${enc(args.name)}/trigger`, {}),
  }),
  defineTool({
    name: 'schedule_runs',
    routes: ['GET /applications/:id/schedules/:name/runs'],
    description:
      'List the recent runs of a scheduled job with their status (Succeeded/Failed/Running). History depth follows the CronJob retention limits.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string(), name: z.string() },
    run: (args, ctx) =>
      ctx.api.get(`${schedules(args.id)}/${enc(args.name)}/runs`),
  }),
  defineTool({
    name: 'schedule_delete',
    routes: ['DELETE /applications/:id/schedules/:name'],
    description:
      'Delete a scheduled job (cron) from an application by its name. Destructive.',
    scope: MCP_SCOPE.APP_DESTRUCTIVE,
    inputSchema: { id: z.string(), name: z.string() },
    run: async (args, ctx) => {
      await ctx.api.delete(`${schedules(args.id)}/${enc(args.name)}`);
      return { deleted: true, name: args.name };
    },
  }),
];
