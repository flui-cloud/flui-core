import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { enc } from './application-views.util';
import {
  coerceNumber,
  defineTool,
  startedOutcome,
  ToolDef,
} from './mcp-tool.util';
import {
  assertQuantities,
  containersView,
  credentialShaped,
  metricsView,
  previousGoodRevision,
  readOrAbsent,
  reconcileView,
  resourceSpec,
  Revision,
  revisionLine,
  SectionsView,
  SelfView,
  TrialLimits,
  TrialSession,
  trialView,
  variablesPath,
  VariablesView,
  variablesView,
} from './self-service.views';

/**
 * What a person can do for their own application, and for their own standing,
 * without an operator in the room.
 *
 * The batch these tools belong to is the first one aimed at a trial guest, and
 * the reason they are worth having is not that the routes were shut — every one
 * of them is already open to a guest — but that no tool named them, so an agent
 * holding a guest's credential could deploy an application and then had no way
 * to undo it, resize it, re-read its configuration, see whether the change took,
 * or say what it was not allowed to try. The fence needed no change for any of
 * this: a tool that declares its `routes` is offered or hidden by
 * `sandbox-tool-visibility.ts` on its own.
 *
 * Three intents, in the order somebody meets them:
 *
 *  - **put it back** — `app_rollback`, `app_set_resources`, `app_reconcile`;
 *  - **see that it worked** — `app_metrics`;
 *  - **know your own edge** — `app_variables`, `app_variable_set` (the
 *    non-secret half only), and `my_permissions`.
 *
 * What each payload is turned into lives in `self-service.views.ts`.
 */

export const SELF_SERVICE_TOOLS: ToolDef[] = [
  defineTool({
    name: 'my_permissions',
    routes: [
      'GET /me/permissions',
      'GET /me/sections',
      'GET /sandbox/session',
      'GET /sandbox/limits',
    ],
    description:
      'Who you are acting as, what this installation lets that principal do, and what is out of reach because of a trial rather than because Flui cannot do it. Read this BEFORE telling somebody a capability is missing, and before attempting a whole plan that one refusal will stop halfway. It distinguishes the three refusals you can meet, which look alike and mean opposite things: a tool you were never handed (a scope on your credential), a resource you are not allowed on (a permission), and an area this trial does not include. Changes nothing.',
    // The read scope, and no scope of its own. A credential that may do nothing
    // at all should still be able to find out that it may do nothing at all —
    // a tool that reports the ceiling and is itself behind a ceiling would be
    // hidden from exactly the caller who needs it.
    scope: MCP_SCOPE.APP_READ,
    inputSchema: {},
    run: async (_args, ctx) => {
      const me = await ctx.api.get<SelfView>('/me/permissions');
      const sections = await ctx.api.get<SectionsView>('/me/sections');
      // The trial pair is asked for last and forgiven when absent: on a paid
      // instance neither route answers, and that absence IS the answer.
      const session = await readOrAbsent<TrialSession>(ctx, '/sandbox/session');
      const limits = session
        ? await readOrAbsent<TrialLimits>(ctx, '/sandbox/limits')
        : undefined;

      return {
        you: { email: ctx.user.email, isAdmin: me.isAdmin ?? false },
        permissions: me.permissions ?? [],
        sections: {
          open: sections.sections ?? [],
          readOnly: sections.readOnlySections ?? [],
        },
        // Read off the request rather than fetched: these are properties of the
        // credential this very call arrived on, and nothing over the wire knows
        // them better than the context does.
        yourAgentCredential: {
          toolScopes: [...ctx.scopes].sort((a, b) => a.localeCompare(b)),
          destructiveToolsEnabled: ctx.allowDestructive,
          note: 'These scopes decide which tools you are OFFERED, never what you may touch. A tool missing from your list will never work for any resource — that is a grant problem, fixed by re-issuing the credential. A tool you hold refusing one resource is a permission problem, fixed in `permissions` above.',
        },
        trial: trialView(session, limits),
      };
    },
  }),

  defineTool({
    name: 'app_rollback',
    routes: ['POST /applications/:id/rollback'],
    description:
      'Put an application back on a previous revision. Call it with just the application id to undo the most recent deploy — the last revision below the current one that did not fail is chosen and named in the answer. Pass revisionNumber (from app_events, which records every deploy and rollback) or buildId (from app_releases) to go somewhere specific. This starts a background operation: follow it with operation_status, passing applicationId, and do not tell anyone it is back until that says done.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      revisionNumber: coerceNumber(z.number().int().positive()).optional(),
      buildId: z.string().optional(),
      reason: z.string().optional(),
    },
    run: async (args, ctx) => {
      let revisionNumber = args.revisionNumber;
      let chosen: string | undefined;

      if (!revisionNumber && !args.buildId) {
        // The preparatory read, and not a route this tool is *about*: the
        // rollback is decided on the route below, which is where the gate is.
        const revisions = await ctx.api.get<Revision[]>(
          `/applications/${enc(args.id)}/revisions`,
        );
        const target = previousGoodRevision(revisions);
        if (!target) {
          throw new Error(
            revisions.length
              ? `Nothing to roll back to: this application has no earlier revision that did not fail. Its revisions are: ${revisions.map(revisionLine).join('; ')}. Deploy a known-good image instead.`
              : 'Nothing to roll back to: this application has no recorded revisions. It has never been deployed through Flui, so there is no earlier state to return to.',
          );
        }
        revisionNumber = target.revisionNumber;
        chosen = revisionLine(target);
      }

      const operation = await ctx.api.post<{ id?: string; status?: string }>(
        `/applications/${enc(args.id)}/rollback`,
        { revisionNumber, buildId: args.buildId, reason: args.reason },
      );
      return {
        applicationId: args.id,
        rollingBackTo: chosen ?? `revision ${revisionNumber ?? args.buildId}`,
        // Said whenever the tool picked, because the model did not: an agent
        // that reports "rolled back" without naming the target has told the
        // person nothing they can check.
        ...(chosen
          ? {
              chosenBy:
                'this tool, as the latest revision below the current one that did not fail — say which one, so the person can disagree',
            }
          : {}),
        ...startedOutcome(
          ctx,
          operation.id ?? '',
          operation.status ?? 'PENDING',
          'Rollback',
        ),
      };
    },
  }),

  defineTool({
    name: 'app_set_resources',
    routes: ['PATCH /applications/:id/resources'],
    description:
      'Change how much CPU and memory an application may use. This is the cure for the OOMKilled that app_debug reports: raise the memory LIMIT, because a container is killed for crossing its limit, never for crossing its request — the request only reserves room on a node. Quantities are Kubernetes ones: cpu as cores ("1", "0.5") or millicores ("500m"), memory as "256Mi", "1Gi". Only what you pass is changed; anything left out keeps its current value. The pods are replaced to apply it, so the application restarts.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      id: z.string(),
      requests: resourceSpec
        .optional()
        .describe('Guaranteed minimums — what the scheduler reserves.'),
      limits: resourceSpec
        .optional()
        .describe('Hard ceilings — crossing the memory one kills the pod.'),
      containerName: z
        .string()
        .optional()
        .describe('Defaults to the first container.'),
    },
    run: (args, ctx) => {
      if (!args.requests && !args.limits) {
        throw new Error(
          'Nothing to change: pass requests, limits, or both. Reading the current values is app_status.',
        );
      }
      assertQuantities(args.requests);
      assertQuantities(args.limits);
      return ctx.api.patch(`/applications/${enc(args.id)}/resources`, {
        requests: args.requests,
        limits: args.limits,
        containerName: args.containerName,
      });
    },
    forModel: containersView,
  }),

  defineTool({
    name: 'app_reconcile',
    routes: ['POST /applications/:id/reconcile'],
    description:
      'Compare an application against what Flui has recorded for it and report what has drifted. Use it when the dashboard and the cluster disagree, or after something was changed outside Flui. It heals the drift only when the application is set to heal automatically; otherwise it observes and says so. Answers immediately — there is no operation to follow.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: { id: z.string() },
    run: (args, ctx) => ctx.api.post(`/applications/${enc(args.id)}/reconcile`),
    forModel: reconcileView,
  }),

  defineTool({
    name: 'app_metrics',
    routes: [
      'GET /observability/applications/:id/metrics',
      'GET /observability/applications/:id/metrics/history',
    ],
    description:
      'CPU, memory, replicas, pod phases and disk usage for one application, measured by Prometheus. Use it to check that a change worked — after app_set_resources, app_scale or app_deploy — and to find the application that is filling its volume, which nothing else reports. It differs from app_status, which reads the cluster directly for the current replica counts: this one carries the network and disk figures app_status has no source for, and can look backwards. Pass sinceMinutes for a time series instead of the instant reading. When nothing has been measured it says so rather than answering zero.',
    scope: MCP_SCOPE.OBS_READ,
    inputSchema: {
      id: z.string(),
      sinceMinutes: coerceNumber(z.number().int().positive().max(10_080))
        .optional()
        .describe(
          'Look back this many minutes instead of reading the instant value. Up to a week.',
        ),
      step: z
        .string()
        .optional()
        .describe(
          'Resolution of a time series, e.g. "60s", "5m". With sinceMinutes only.',
        ),
    },
    run: (args, ctx) => {
      const base = `/observability/applications/${enc(args.id)}/metrics`;
      if (!args.sinceMinutes) return ctx.api.get(base);
      const end = new Date();
      const start = new Date(end.getTime() - args.sinceMinutes * 60_000);
      return ctx.api.get(`${base}/history`, {
        start: start.toISOString(),
        end: end.toISOString(),
        step: args.step,
      });
    },
    // Only the instant shape is projected. A history answer is a list of data
    // points whose fields the projection above does not recognise, and a view
    // that silently reshaped it into `measured: false` would report a healthy
    // application as unmeasured — so the range answer is passed through whole.
    forModel: (data) =>
      (data as { data_points?: unknown }).data_points
        ? data
        : metricsView(data),
  }),

  defineTool({
    name: 'app_variables',
    routes: ['GET /variables/applications/:appId'],
    description:
      "Read an application's configuration: the plain variables with their values, the sensitive keys that are configured, and the keys declared but still waiting for somebody to supply a value. A sensitive value is never returned here, by anybody, and cannot be — asking a second time does not help, and inventing one to fill the gap is the one thing you must not do. Read this before writing a variable, so you merge into what is there instead of guessing at it.",
    scope: MCP_SCOPE.APP_READ,
    inputSchema: { applicationId: z.string() },
    run: (args, ctx) => ctx.api.get(variablesPath(args.applicationId)),
    forModel: variablesView,
  }),

  defineTool({
    name: 'app_variable_set',
    routes: ['PUT /variables/applications/:appId'],
    description:
      'Set NON-SECRET configuration on an application — a hostname, a log level, a feature flag, a port. Values are written in clear text to a ConfigMap, so nothing confidential may go through here: passwords, API keys and tokens are delivered by a person with app_variable_request, and this tool refuses them rather than storing them in the open. Existing keys you do not name are left alone. The change reaches the running pods on the next deploy or restart, not immediately.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      applicationId: z.string(),
      variables: z
        .record(z.string(), z.string())
        .describe(
          'Key/value pairs. Plain configuration only — never a secret.',
        ),
    },
    run: async (args, ctx) => {
      const entries = Object.entries(args.variables);
      if (!entries.length) {
        throw new Error(
          'Nothing to write: `variables` is empty. Reading them is app_variables.',
        );
      }

      // The state the product already holds, asked before anything is written.
      // A key it knows as sensitive is refused on evidence rather than on the
      // look of its name — and this is the check that matters, because it
      // catches the ordinary-looking key that a person has already delivered a
      // secret into.
      const before = await ctx.api.get<VariablesView>(
        variablesPath(args.applicationId),
      );
      const known = new Set([
        ...(before.sensitiveKeys ?? []),
        ...(before.pendingKeys ?? []),
      ]);

      const refusals = entries
        .map(([key, value]) =>
          known.has(key)
            ? `${key} — this application already holds it as a SENSITIVE variable; writing it in clear here would put a secret in a ConfigMap beside it.`
            : credentialShaped(key, value),
        )
        .filter((r): r is string => !!r);

      if (refusals.length) {
        // Nothing partial. Writing the acceptable half and refusing the rest
        // would leave the caller unsure which keys landed, and an agent that is
        // unsure writes them all again.
        throw new Error(
          `Refused, and nothing was written — not one of the ${entries.length} keys.\n${refusals.join('\n')}\n\nDeliver each of these with app_variable_request instead: it records the key as awaiting a value and hands the person a command that sends the value straight to encrypted storage, without it passing through you. Then call this tool again with only the remaining, non-secret keys.`,
        );
      }

      return ctx.api.put(`${variablesPath(args.applicationId)}?type=plain`, {
        data: args.variables,
      });
    },
    forModel: variablesView,
  }),
];
