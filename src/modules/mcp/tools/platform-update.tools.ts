import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { ToolDef, coerceBoolean, defineTool } from './mcp-tool.util';

const ACKNOWLEDGEMENT =
  'Without a backup, a database migration cannot be undone.';

/**
 * Applying pauses on the route (`@ActionCycle` naming the release), never in
 * the tool.
 */
export const PLATFORM_UPDATE_TOOLS: ToolDef[] = [
  defineTool({
    name: 'platform_update_status',
    routes: [
      'GET /platform/updates',
      'GET /platform/updates/current',
      'GET /platform/updates/history',
    ],
    description:
      'Which Flui release this installation runs, which one is on offer, and the update in flight — its phases (backup, manifests, images, K3s, checks), each cluster it reached and, for K3s, every node. With no update running, the last one, so a failure can be read with the guidance it left. Relay `guidance` word for word when an update failed: nothing is rolled back on its own.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: {},
    run: async (_args, ctx) => {
      const release =
        await ctx.api.get<Record<string, unknown>>('/platform/updates');
      const current = await ctx.api.get<Record<string, unknown> | null>(
        '/platform/updates/current',
      );
      if (current) return { release, current };
      const [last] =
        (await ctx.api.get<Array<Record<string, unknown>>>(
          '/platform/updates/history?limit=1',
        )) ?? [];
      return { release, current: null, last: last ?? null };
    },
  }),

  defineTool({
    name: 'platform_update_plan',
    routes: ['POST /platform/updates/plan'],
    description:
      'Plan a platform update without changing anything: the backup taken first, the system manifests brought forward (the control first), the platform images (the API last), K3s one minor version at a time (workload clusters first, the control last) and the checks — with every blocker. Show the person the phases, the blockers and the advisories before proposing platform_update_apply, and pass it the `planId` this returns.',
    scope: MCP_SCOPE.PLATFORM_UPDATE,
    inputSchema: {
      targetVersion: z
        .string()
        .optional()
        .describe('The release to plan for. Omit for the one on offer.'),
    },
    run: (args, ctx) =>
      ctx.api.post('/platform/updates/plan', {
        ...(args.targetVersion ? { targetVersion: args.targetVersion } : {}),
      }),
  }),

  defineTool({
    name: 'platform_update_apply',
    routes: ['POST /platform/updates'],
    description: `Apply a plan platform_update_plan returned: one operation that backs up, brings the manifests forward, rolls out the images, upgrades K3s and checks. Refused if anything changed since the plan — plan again. THIS ASKS A PERSON: it passes through Flui's approval cycle; stop, say which release was asked for, and retry the identical call once they answer. The API restarts during it; follow it with platform_update_status. Going without the backup needs withoutBackup and the acknowledgement, exactly: "${ACKNOWLEDGEMENT}" — only when the person said so.`,
    scope: MCP_SCOPE.PLATFORM_UPDATE,
    inputSchema: {
      targetVersion: z.string().describe('The release the plan was made for.'),
      planId: z.string().describe('The planId platform_update_plan returned.'),
      withoutBackup: coerceBoolean().optional(),
      acknowledgement: z.string().optional(),
    },
    run: (args, ctx) =>
      ctx.api.post('/platform/updates', {
        targetVersion: args.targetVersion,
        planId: args.planId,
        ...(args.withoutBackup ? { withoutBackup: true } : {}),
        ...(args.acknowledgement
          ? { acknowledgement: args.acknowledgement }
          : {}),
      }),
  }),
];
