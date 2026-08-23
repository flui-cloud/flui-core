import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  defineTool,
  McpToolContext,
  resolveClusterId,
  ToolDef,
} from './mcp-tool.util';

/** Path-segment safety: an id from a model is input, not a literal. */
const enc = encodeURIComponent;

interface ZoneAssignment {
  id: string;
  dnsZone?: { zoneName?: string } | null;
  wildcardCertificate?: boolean;
}

function listZoneAssignments(
  ctx: McpToolContext,
  clusterId: string,
): Promise<ZoneAssignment[]> {
  return ctx.api.get<ZoneAssignment[]>(
    `/clusters/${enc(clusterId)}/dns-zone/list`,
  );
}

/**
 * How a cluster's applications get their names.
 *
 * Every application is published at `<slug>.<cluster>.<zone>` and resolves to
 * the same address, so a single `*.<cluster>` record covers all of them —
 * including the ones that do not exist yet. That is what makes a newly deployed
 * application answer straight away instead of waiting about a minute for a
 * brand-new name to reach the world's resolvers.
 *
 * Worth an agent's attention because it is the usual answer to "I deployed it
 * and the URL does not work yet": nothing is broken, the name is simply new.
 */
export const DNS_TOOLS: ToolDef[] = [
  defineTool({
    name: 'dns_wildcard_status',
    routes: ['GET /clusters/:clusterId/dns-zone/:zoneId/wildcard'],
    description:
      'Check whether one DNS record covers every application on a cluster. Applications are published at <slug>.<cluster>.<zone>; with the wildcard in place a newly deployed application resolves immediately, without it each new name takes about a minute to propagate. Call this when a freshly deployed application\'s URL does not resolve yet — it distinguishes "the name is new" from "something is broken". Returns one entry per DNS zone assigned to the cluster.',
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { clusterId: z.string().optional() },
    // One read per assigned zone, after one read of the assignments. They are
    // independent reads of different zones and nothing here writes, so the
    // fan-out adds no window that the single in-process call did not have: the
    // provider is queried live either way, and two zones were already two
    // queries.
    run: async (args, ctx) => {
      const clusterId = await resolveClusterId(ctx, args.clusterId);
      const assignments = await listZoneAssignments(ctx, clusterId);
      return Promise.all(
        assignments.map(async (a) => ({
          zone: a.dnsZone?.zoneName ?? null,
          assignmentId: a.id,
          wildcardCertificate: a.wildcardCertificate,
          wildcard: await ctx.api.get(
            `/clusters/${enc(clusterId)}/dns-zone/${enc(a.id)}/wildcard`,
          ),
        })),
      );
    },
    forModel: (data) => {
      const rows = (data as Array<Record<string, any>>) ?? [];
      if (rows.length === 0) {
        return {
          zones: [],
          summary:
            'This cluster has no DNS zone assigned; applications fall back to nip.io hostnames, which resolve immediately.',
        };
      }
      const zones = rows.map((r) => ({
        zone: r.zone,
        applications: r.wildcard?.hostnamePattern,
        wildcardRecord: r.wildcard?.status,
        wildcardCertificate: r.wildcardCertificate,
        pointsAt: r.wildcard?.actualValue ?? r.wildcard?.expectedValue,
      }));
      // The one sentence that decides what the agent should say next.
      const absent = zones.filter((z) => z.wildcardRecord === 'absent');
      const foreign = zones.filter((z) => z.wildcardRecord === 'foreign');
      let summary =
        'Every zone is covered by a wildcard — a new application resolves as soon as it is deployed.';
      if (absent.length > 0) {
        summary = `No wildcard on ${absent.map((z) => z.zone).join(', ')}: each new application publishes its own name and takes about a minute to become reachable. dns_wildcard_publish fixes that for good.`;
      } else if (foreign.length > 0) {
        summary = `A wildcard exists on ${foreign.map((z) => z.zone).join(', ')} but points elsewhere, so Flui leaves it alone and applications keep their own records. Changing it is a decision for a person, not for this tool.`;
      }
      return { zones, summary };
    },
  }),

  defineTool({
    name: 'dns_wildcard_publish',
    routes: ['POST /clusters/:clusterId/dns-zone/:zoneId/wildcard'],
    description:
      'Publish the DNS record that covers every application on a cluster, so newly deployed applications resolve immediately instead of waiting for their own name to propagate. Creates one record per assigned zone and never overwrites: a wildcard already pointing somewhere else is left exactly as it is and comes back as "foreign". Safe to call more than once.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { clusterId: z.string().optional() },
    // One publish per assigned zone. The publish is idempotent and never
    // overwrites a foreign record, so repeating it — or racing it with another
    // caller — cannot produce a different outcome than doing it once.
    run: async (args, ctx) => {
      const clusterId = await resolveClusterId(ctx, args.clusterId);
      const assignments = await listZoneAssignments(ctx, clusterId);
      return Promise.all(
        assignments.map(async (a) => ({
          zone: a.dnsZone?.zoneName ?? null,
          wildcard: await ctx.api.post(
            `/clusters/${enc(clusterId)}/dns-zone/${enc(a.id)}/wildcard`,
            {},
          ),
        })),
      );
    },
    forModel: (data) => {
      const rows = (data as Array<Record<string, any>>) ?? [];
      const zones = rows.map((r) => ({
        zone: r.zone,
        record: r.wildcard?.fqdn,
        status: r.wildcard?.status,
        pointsAt: r.wildcard?.actualValue ?? r.wildcard?.expectedValue,
      }));
      const untouched = zones.filter((z) => z.status === 'foreign');
      return {
        zones,
        summary:
          untouched.length > 0
            ? `Left ${untouched.map((z) => z.zone).join(', ')} alone: a wildcard is already there pointing somewhere else. Applications on those zones keep their own per-application records, which still work — they are just slower to appear.`
            : 'Published. From now on a new application on this cluster answers as soon as it is deployed.',
      };
    },
  }),
];
