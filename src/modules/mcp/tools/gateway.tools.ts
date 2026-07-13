import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  coerceBoolean,
  coerceNumber,
  defineTool,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';

const minRole = z.enum(['viewer', 'editor', 'manager']);

const rateLimitShape = {
  average: coerceNumber(z.number().int().min(1)),
  burst: coerceNumber(z.number().int().min(1)).optional(),
  period: z
    .string()
    .regex(/^\d+(ms|s|m|h)$/)
    .optional(),
};

// z.preprocess widens the inferred property to optional; re-narrow for the DTO.
function toRateLimit(rl?: {
  average?: number;
  burst?: number;
  period?: string;
}): { average: number; burst?: number; period?: string } | undefined {
  if (!rl?.average) return undefined;
  return { average: rl.average, burst: rl.burst, period: rl.period };
}

/**
 * Gateway (L7 routing) tools. Routes are the app's endpoints; policies
 * (SSO auth, rate limit, IP allowlist, path) compile to Traefik resources.
 * Mutations reconcile in the background — gateway_status reads the loop.
 */
export const GATEWAY_TOOLS: ToolDef[] = [
  defineTool({
    name: 'gateway_list_routes',
    description:
      'List the gateway routes of an application (pass id) or of the whole cluster (pass clusterId, read-only global view). Each route is host+path → app service with its policies (auth/rateLimit/allowIps), TLS and reconciliation status.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {
      id: z.string().optional(),
      clusterId: z.string().optional(),
    },
    run: async (args, ctx) => {
      if (args.id) return ctx.services.gateway.listRoutes(args.id);
      const clusterId = await resolveClusterId(ctx, args.clusterId);
      return ctx.services.gateway.listClusterRoutes(clusterId);
    },
    forModel: (data) => {
      const routes = (data as Array<Record<string, unknown>>) ?? [];
      return routes.map((r) => ({
        endpointId: r.endpointId,
        host: r.host,
        path: r.path,
        applicationSlug: r.applicationSlug,
        tlsEnabled: r.tlsEnabled,
        auth: r.auth,
        rateLimit: r.rateLimit,
        allowIps: r.allowIps,
        reconciliationStatus: r.reconciliationStatus,
        errorMessage: r.errorMessage,
      }));
    },
  }),
  defineTool({
    name: 'gateway_route_add',
    description:
      'Add a gateway route to an application: host (fqdn) [+ path prefix] pointing at the app service, with optional policies (sso/minRole, rate limit, IP allowlist). DNS, TLS and Ingress reconcile in the background — check gateway_status afterwards. The DNS zone is auto-matched from the host; unmatched hosts require the user to point DNS at the cluster themselves.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      host: z.string(),
      path: z.string().optional(),
      sso: coerceBoolean().optional(),
      minRole: minRole.optional(),
      rateLimit: z.object(rateLimitShape).optional(),
      allowIps: z.array(z.string()).optional(),
      certificateRequired: coerceBoolean().optional(),
    },
    run: (args, ctx) =>
      ctx.services.gateway.addRoute(args.id, {
        host: args.host,
        path: args.path,
        certificateRequired: args.certificateRequired,
        auth: args.sso ? { sso: true, minRole: args.minRole } : undefined,
        rateLimit: toRateLimit(args.rateLimit),
        allowIps: args.allowIps,
      }),
  }),
  defineTool({
    name: 'gateway_set_policy',
    description:
      'Set or clear gateway policies on a route of an application. Identify the route by endpointId (from gateway_list_routes). Omitted fields are unchanged; to clear a policy pass clearAuth/clearRateLimit/clearAllowIps=true. sso=true gates the route behind Flui SSO; minRole additionally requires that IAM role on the app.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      endpointId: z.string(),
      path: z.string().optional(),
      sso: coerceBoolean().optional(),
      minRole: minRole.optional(),
      rateLimit: z.object(rateLimitShape).optional(),
      allowIps: z.array(z.string()).optional(),
      clearAuth: coerceBoolean().optional(),
      clearRateLimit: coerceBoolean().optional(),
      clearAllowIps: coerceBoolean().optional(),
    },
    run: (args, ctx) => {
      let auth:
        | { sso: boolean; minRole?: typeof args.minRole }
        | null
        | undefined;
      if (args.clearAuth) {
        auth = null;
      } else if (args.sso !== undefined || args.minRole !== undefined) {
        auth = { sso: args.sso ?? true, minRole: args.minRole };
      }
      return ctx.services.gateway.setPolicy(args.id, args.endpointId, {
        path: args.path,
        auth,
        rateLimit: args.clearRateLimit ? null : toRateLimit(args.rateLimit),
        allowIps: args.clearAllowIps ? null : args.allowIps,
      });
    },
  }),
  defineTool({
    name: 'gateway_status',
    description:
      'Reconciliation status of the gateway routes of an application: synced / reconciling / error per route, with error messages. Use after gateway mutations to confirm the change landed.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.services.gateway.status(args.id),
  }),
  defineTool({
    name: 'gateway_route_compiled',
    description:
      'Preview the compiled Traefik resources (Middleware CRDs + Ingress annotation) for a route without applying them. Useful to explain what a policy change will do.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { id: z.string(), endpointId: z.string() },
    run: (args, ctx) =>
      ctx.services.gateway.compiledRoute(args.id, args.endpointId),
  }),
  defineTool({
    name: 'gateway_route_remove',
    description:
      'Remove a gateway route from an application by endpointId, cleaning up its DNS record, certificate, Ingress and middlewares. Destructive.',
    scope: MCP_SCOPE.APP_DESTRUCTIVE,
    inputSchema: { id: z.string(), endpointId: z.string() },
    run: async (args, ctx) => {
      await ctx.services.gateway.removeRoute(args.id, args.endpointId);
      return { deleted: true, endpointId: args.endpointId };
    },
  }),
];
