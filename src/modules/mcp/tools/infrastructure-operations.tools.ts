import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  McpToolContext,
  ToolDef,
  coerceNumber,
  defineTool,
  resolveClusterId,
  startedOutcome,
} from './mcp-tool.util';

/**
 * The tools that write to the machine room — and the reads that price them.
 *
 * ── Where the pause lives ──────────────────────────────────────────────────
 *
 * Nowhere in this file. Not one tool here asks whether it may proceed, keeps a
 * pending state, or offers a confirmation argument. Every one of them calls the
 * API over HTTP as the caller's own principal and **meets `ActionCycleGuard` on
 * the way in**, fifth in the global chain, where the route it lands on declares
 * `@ActionCycle`. That is the whole design and it is worth saying why the
 * obvious alternative is wrong: a confirmation the tool performed would be a
 * control the same credential skips by calling the route with `curl`, and the
 * credential — not the client — is what says an agent is acting.
 *
 * What the agent sees when the pause fires is not a failure. `runGated` turns
 * the guard's typed refusal into `input_required` with the page a person
 * decides on, and the agent's job is to stop, say what was asked for, and
 * **retry the identical call** once somebody has answered. The retry is what
 * executes; the click does not. See `action-cycle-wait.spec.ts`.
 *
 * ── The estimate ───────────────────────────────────────────────────────────
 *
 * A proposal that cannot say what the action costs is an approval given blind.
 * Every decorated route in this set that has a pricing GET names it in
 * `@ActionCycle({ estimate })`, and the same GET is published here as a read
 * tool so the agent can put the number in front of the person *before* it even
 * asks. The pairs are: add/remove a node and change autoscaling →
 * `cluster_capacity_plan`; resize a node → `cluster_node_scale_preview`; expand
 * storage → `cluster_storage_status`; redeploy a component →
 * `platform_component_list`.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * **Destroying a cluster.** Not an oversight and not caution: `cluster:destroy`
 * is carried by no agent scope at all, pinned in two places
 * (`api-key-scopes.spec.ts`, and `NO_SCOPE_CARRIES` in the route sentinel), so
 * a tool for it would be one every scoped credential is refused. Widening that
 * is a decision to take out loud, in those files, not a tool to add here.
 *
 * **Cordoning a node.** There is a route that uncordons and none that cordons —
 * cordoning only happens inside resize and removal. A tool for it would have to
 * invent the route.
 *
 * **Syncing the system domains.** The three `sync-*-domain` routes each want
 * the UUIDs of `flui-api` and `flui-web`, and nothing an agent can read hands
 * them over. A tool that guessed them would fail plausibly, which is the one
 * failure an agent cannot detect.
 */

/** Every route in this file is cluster-shaped; the id resolves the same way. */
const clusterArg = { clusterId: z.string().optional() };

const NODE_ID = z
  .string()
  .describe('Cluster node id, as reported by cluster_node_list.');

function encoded(...parts: string[]): string {
  return parts.map(encodeURIComponent).join('/');
}

/** What the async cluster routes answer with, in their snake-case shape. */
interface QueuedOperation {
  operation_id: string;
  status: string;
}

/**
 * The handle of an operation one of these routes just queued.
 *
 * Kept in one place because the shape is the cluster controller's, not the
 * application controller's: `operation_id` and a lowercase `status`, where
 * `startedOutcome` reads the terminal set in upper case. Normalising here means
 * "is it finished" is answered the same way for an install and for a node.
 */
function queued(
  ctx: McpToolContext,
  operation: QueuedOperation,
  label: string,
): ReturnType<typeof startedOutcome> {
  return startedOutcome(
    ctx,
    operation.operation_id,
    (operation.status ?? 'PENDING').toUpperCase(),
    label,
  );
}

export const INFRASTRUCTURE_OPERATION_TOOLS: ToolDef[] = [
  // ── Reads: what a change would cost, and what there is to change ─────────

  defineTool({
    name: 'cluster_capacity_plan',
    routes: ['GET /infrastructure/clusters/:id/capacity-plan'],
    description:
      "The master node's current capacity and the resize candidates for it, each with a monthly cost delta. This is the price tag on cluster_node_add, cluster_node_remove and cluster_autoscale_set — read it and tell the person the number BEFORE asking them to approve one of those, not after. Reports free/used/allocatable capacity and the current server type.",
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(
        `/infrastructure/clusters/${encoded(id)}/capacity-plan`,
      );
    },
  }),

  defineTool({
    name: 'cluster_node_list',
    routes: ['GET /infrastructure/clusters/:id/nodes'],
    description:
      'The nodes of a cluster with their ids, roles and status. Call this to get the nodeId every node-scoped tool needs — never guess one, and never pass a Kubernetes node name where a nodeId is asked for.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(`/infrastructure/clusters/${encoded(id)}/nodes`);
    },
  }),

  defineTool({
    name: 'cluster_node_scale_preview',
    routes: ['GET /infrastructure/clusters/:id/nodes/:nodeId/scale/preview'],
    description:
      'What resizing one node would take down: its current server type, the dedicated workloads on it and the expected downtime. This is the estimate attached to cluster_node_resize — read it first and say the downtime out loud, because everything scheduled on that node, dedicated databases included, is unavailable for the whole window.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: { ...clusterArg, nodeId: NODE_ID },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(
        `/infrastructure/clusters/${encoded(id)}/nodes/${encoded(args.nodeId)}/scale/preview`,
      );
    },
  }),

  defineTool({
    name: 'cluster_storage_status',
    routes: ['GET /infrastructure/clusters/:id/storage'],
    description:
      "The cluster's shared-storage layer: the backing volume and its size, the NFS export and a summary of the claims on it. Read it before cluster_storage_expand — a volume can only ever grow, so the new size has to be chosen once and knowingly.",
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(`/infrastructure/clusters/${encoded(id)}/storage`);
    },
  }),

  defineTool({
    name: 'platform_component_list',
    routes: ['GET /infrastructure/clusters/:clusterId/platform-components'],
    description:
      "The platform components running on a cluster — ingress, cert-manager, CoreDNS and their neighbours — with their health. These are the instance's own plumbing, not anybody's application: use this to find the componentKey for platform_component_redeploy, and to check whether a component is actually unhealthy before proposing to restart it.",
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(
        `/infrastructure/clusters/${encoded(id)}/platform-components`,
      );
    },
  }),

  defineTool({
    name: 'dns_issuer_list',
    routes: ['GET /clusters/:clusterId/dns-zone/issuers'],
    description:
      'The cert-manager ClusterIssuers configured on a cluster — which of staging/production and http/dns exist, and what each is bound to. Read it before dns_issuer_configure: reconfiguring an issuer that is already correct churns certificates for nothing.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(`/clusters/${encoded(id)}/dns-zone/issuers`);
    },
  }),

  defineTool({
    name: 'dns_internal_hosting',
    routes: ['GET /clusters/:clusterId/dns-zone/internal-hosting'],
    description:
      'Whether this cluster serves DNS for itself, and how far that setup has got. Read-only: it answers "is the name resolution for these hostnames ours or somebody else\'s", which decides whether a wildcard or a DNS-01 challenge can work here at all.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(`/clusters/${encoded(id)}/dns-zone/internal-hosting`);
    },
  }),

  defineTool({
    name: 'san_certificate_list',
    routes: ['GET /clusters/:clusterId/san-certificates'],
    description:
      'The SAN certificates on a cluster — each one covering up to 20 hostnames under a single certificate — with their names and current state. Read it before san_certificate_create: a name is unique per cluster, and adding a hostname to an existing certificate is not what create does.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get(`/clusters/${encoded(id)}/san-certificates`);
    },
  }),

  // ── Writes: every one of them meets the action cycle on the route ────────

  defineTool({
    name: 'cluster_create',
    routes: ['POST /infrastructure/clusters'],
    description:
      'Create a new K3s cluster at a cloud provider. This spends money for as long as the cluster exists, so it stops to ask a person first and can only ever be allowed ONCE — there is no standing permission for it, because a request that names no existing resource cannot state its own boundary. `region` and `nodeSize` are provider codes (Hetzner: fsn1/cx22, Scaleway: fr-par-1/PRO2-S): take them from the person, never invent one. Returns an operation handle; provisioning takes 8-15 minutes.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      name: z
        .string()
        .min(3)
        .max(63)
        .describe('Cluster name, unique on this instance.'),
      provider: z
        .string()
        .describe('Cloud provider key, e.g. `hetzner` or `scaleway`.'),
      region: z.string().describe('Provider region/location code.'),
      nodeSize: z
        .string()
        .describe('Provider server type, applied to every node.'),
      workerCount: coerceNumber(z.number().int().min(0).max(19)).describe(
        'Worker nodes beside the master. 0 means master-only.',
      ),
      autoscalingEnabled: z.boolean().optional(),
    },
    run: async (args, ctx) => {
      const operation = await ctx.api.post<QueuedOperation>(
        '/infrastructure/clusters',
        args,
      );
      return queued(ctx, operation, `Create cluster ${args.name}`);
    },
  }),

  defineTool({
    name: 'cluster_node_add',
    routes: ['POST /infrastructure/clusters/:id/workers'],
    description:
      'Add 1-5 worker nodes to an existing cluster. Each node is a machine that is paid for from the moment it boots, so read cluster_capacity_plan first and tell the person the monthly delta. Requires the cluster to have a VNet and to be READY. Takes 3-6 minutes per node.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      count: coerceNumber(z.number().int().min(1).max(5)).optional(),
    },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      const operation = await ctx.api.post<QueuedOperation>(
        `/infrastructure/clusters/${encoded(id)}/workers`,
        { count: args.count ?? 1 },
      );
      return queued(ctx, operation, `Add ${args.count ?? 1} worker node(s)`);
    },
  }),

  defineTool({
    name: 'cluster_node_remove',
    routes: ['DELETE /infrastructure/clusters/:id/workers/:nodeId'],
    description:
      'Cordon, drain and delete one worker node at the provider. The machine is gone afterwards and anything on it that was not on shared storage goes with it. The drain has a 120s timeout: if a PodDisruptionBudget blocks eviction the node is removed anyway and the operation reports a DRAIN_FAILED warning — read the warnings and say so. Refused on the master and when it would breach minNodes.',
    // The one act in this area that takes a machine away from under running
    // workloads, so it sits behind the server-wide destructive flag as well as
    // behind the person's approval. Adding a node back is not the same as not
    // having removed this one.
    scope: MCP_SCOPE.INFRA_DESTRUCTIVE,
    inputSchema: { ...clusterArg, nodeId: NODE_ID },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      const operation = await ctx.api.delete<QueuedOperation>(
        `/infrastructure/clusters/${encoded(id)}/workers/${encoded(args.nodeId)}`,
      );
      return queued(ctx, operation, `Remove worker node ${args.nodeId}`);
    },
  }),

  defineTool({
    name: 'cluster_node_resize',
    routes: ['POST /infrastructure/clusters/:id/nodes/:nodeId/scale'],
    description:
      'Vertically resize one node: cordon, power off, change the server type at the provider, power on, wait for the node to be Ready again. This is a maintenance window of roughly 3-5 minutes during which every pod on that node — dedicated databases included — is down. Call cluster_node_scale_preview first and say the downtime out loud. Growing the local OS disk is deliberately not offered here: it is a one-way change that permanently blocks resizing back down.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      nodeId: NODE_ID,
      targetServerType: z
        .string()
        .describe('Provider server type to move to, e.g. `cx32`.'),
    },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.post(
        `/infrastructure/clusters/${encoded(id)}/nodes/${encoded(args.nodeId)}/scale`,
        { targetServerType: args.targetServerType },
      );
    },
  }),

  defineTool({
    name: 'cluster_node_uncordon',
    routes: ['POST /infrastructure/clusters/:id/nodes/:nodeId/uncordon'],
    description:
      'Mark a node schedulable again. A recovery helper: use it when a resize or a removal stopped before its uncordon step and left the node refusing new pods. There is no matching tool to cordon a node — cordoning only happens inside those two operations.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: { ...clusterArg, nodeId: NODE_ID },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.post(
        `/infrastructure/clusters/${encoded(id)}/nodes/${encoded(args.nodeId)}/uncordon`,
      );
    },
  }),

  defineTool({
    name: 'cluster_storage_expand',
    routes: ['POST /infrastructure/clusters/:id/storage/expand'],
    description:
      'Grow the shared-storage volume behind the cluster and the filesystem on it. Online for ext4, so no downtime is expected. It is one-way: a provider volume can never be made smaller again, and the larger size is billed from now on. Read cluster_storage_status for the current size and pass a larger one.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      targetSizeGb: coerceNumber(z.number().int().min(1)).describe(
        'New size in GB, greater than the current one.',
      ),
    },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.post(
        `/infrastructure/clusters/${encoded(id)}/storage/expand`,
        { targetSizeGb: args.targetSizeGb },
      );
    },
  }),

  defineTool({
    name: 'cluster_power',
    routes: [
      'POST /infrastructure/clusters/:id/stop',
      'POST /infrastructure/clusters/:id/start',
    ],
    description:
      'Power every server of a cluster off, or back on. Stopping takes EVERYTHING on the cluster offline — every application, every database — while preserving all data and cutting the server bill by roughly 92%; starting boots them again and takes 2-5 minutes before anything is serving. Never stop a cluster because it looks idle: it is the whole instance going dark, and only the person can decide that.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      action: z.enum(['stop', 'start']),
    },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      const operation = await ctx.api.post<QueuedOperation>(
        `/infrastructure/clusters/${encoded(id)}/${args.action}`,
      );
      return queued(ctx, operation, `${args.action} cluster`);
    },
  }),

  defineTool({
    name: 'cluster_autoscale_set',
    routes: ['PATCH /infrastructure/clusters/:id/autoscale'],
    description:
      'Change how a cluster scales itself: on or off, the node bounds and the thresholds that trigger a scale-up. Raising maxNodes raises the ceiling on what this cluster can spend without anybody being asked again, so read cluster_capacity_plan and state the cost per node first. Enabling autoscaling on a cluster with no VNet is refused with a 400 — that one cannot be fixed here, only by re-creating the cluster.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      autoscalingEnabled: z.boolean().optional(),
      minNodes: coerceNumber(z.number().int().min(1).max(20)).optional(),
      maxNodes: coerceNumber(z.number().int().min(1).max(20)).optional(),
      scaleUpMemoryPct: coerceNumber(
        z.number().int().min(50).max(95),
      ).optional(),
      scaleUpCpuPct: coerceNumber(z.number().int().min(50).max(95)).optional(),
    },
    run: async (args, ctx) => {
      const { clusterId, ...body } = args;
      const id = await resolveClusterId(ctx, clusterId);
      return ctx.api.patch(
        `/infrastructure/clusters/${encoded(id)}/autoscale`,
        body,
      );
    },
  }),

  defineTool({
    name: 'cluster_firewall_enable',
    routes: ['POST /firewalls/cluster/:clusterId/enable'],
    description:
      'Ensure the cluster has a firewall and apply it. Idempotent: it seeds the default rules for this cluster type when none exists and re-applies the desired state when one does. It changes what can reach the nodes from outside, so it asks a person first. Editing individual rules is not offered to an agent — a wrong rule here is the kind that locks everybody out of a live cluster.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: clusterArg,
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.post(`/firewalls/cluster/${encoded(id)}/enable`);
    },
  }),

  defineTool({
    name: 'platform_component_redeploy',
    routes: [
      'POST /infrastructure/clusters/:clusterId/platform-components/:componentKey/actions/redeploy',
    ],
    description:
      "Rolling-restart one of the instance's own platform components (ingress, cert-manager, CoreDNS and the like). This is plumbing every application on the cluster depends on: restarting the ingress interrupts every request in flight, and restarting CoreDNS interrupts name resolution for the whole cluster. Read platform_component_list first and only propose this for a component that is actually unhealthy.",
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      componentKey: z
        .string()
        .describe('Component key from platform_component_list.'),
    },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.post(
        `/infrastructure/clusters/${encoded(id)}/platform-components/${encoded(args.componentKey)}/actions/redeploy`,
      );
    },
  }),

  defineTool({
    name: 'dns_issuer_configure',
    routes: ['POST /clusters/:clusterId/dns-zone/configure-issuer/:type'],
    description:
      "Create or update the cert-manager ClusterIssuers of one type on a cluster: `http` gives the two HTTP-01 issuers, `dns` gives the two wildcard DNS-01 ones. Both staging and production are written together. The email is registered with Let's Encrypt and is where expiry warnings go — ask for it, never invent one. Read dns_issuer_list first: reconfiguring an issuer that is already right re-issues certificates for nothing.",
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      type: z.enum(['http', 'dns']),
      acmeEmail: z
        .email()
        .describe('ACME registration address for this issuer.'),
    },
    run: async (args, ctx) => {
      const id = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.post(
        `/clusters/${encoded(id)}/dns-zone/configure-issuer/${encoded(args.type)}`,
        { acmeEmail: args.acmeEmail },
      );
    },
  }),

  defineTool({
    name: 'san_certificate_create',
    routes: ['POST /clusters/:clusterId/san-certificates'],
    description:
      'Issue one certificate covering up to 20 hostnames. `http-01` accepts hostnames from any zone provided each already resolves to the cluster; `dns-01` requires every hostname to sit under the one cluster DNS zone named in clusterDnsZoneId. The name is unique per cluster and cannot be reused — read san_certificate_list first. Reconciliation runs in the background; a wrong hostname list means a certificate that never becomes ready, so read the list back to the person before proposing this.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      ...clusterArg,
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .describe('Stable name, unique within the cluster.'),
      fqdns: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Hostnames to cover, at most 20.'),
      certChallenge: z.enum(['http-01', 'dns-01']),
      clusterDnsZoneId: z
        .string()
        .optional()
        .describe('Required for dns-01: the zone every hostname is under.'),
    },
    run: async (args, ctx) => {
      const { clusterId, ...body } = args;
      const id = await resolveClusterId(ctx, clusterId);
      return ctx.api.post(`/clusters/${encoded(id)}/san-certificates`, body);
    },
  }),

  defineTool({
    name: 'mail_domain_publish',
    routes: ['POST /mail/domains/:domain/publish'],
    description:
      "Register a sending domain and publish the DNS records it needs. This is DNS, not delivery: it writes records, it never sends anything, and an agent is not given any way to send mail from this instance. Idempotent — safe to call again while waiting. When Flui holds the zone the records are written for you; when it does not they come back under `outstanding` for somebody to publish where the zone really lives. Verification is the provider's to give and lags DNS by minutes: poll mail_readiness for it rather than calling this again.",
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      domain: z.string().describe('The sending domain, e.g. `example.com`.'),
    },
    run: (args, ctx) =>
      ctx.api.post(`/mail/domains/${encoded(args.domain)}/publish`),
  }),
];
