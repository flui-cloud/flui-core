import { z, ZodRawShape } from 'zod';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpScope, SCOPE_TIER } from '../constants/mcp-scopes';
import type {
  RequestStateCodec,
  ServerContext,
} from '@modelcontextprotocol/server';
import {
  InputRequiredResult,
  McpRequestRound,
  inputRequired,
  isInputRequired,
  readRound,
} from '../protocol/mrtr';
import { describeError } from '../../shared/utils/error.util';
import { McpApiCaller, McpApiError } from '../services/mcp-api.client';
import { Actor } from '../../auth/utils/actor-context';
import {
  redactToolArgs,
  startedOperationId,
} from '../audit/tool-arg-redaction';
import {
  PROPOSAL_DECISION_PATH,
  ProposalRefusal,
} from '../../action-cycle/action-cycle.core';

/** A tool result in MCP's content shape. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Which consumer is running the tool. The two differ in what the caller can see:
 * the Flui UI renders a progress widget for async operations, an external MCP
 * client renders nothing. Guidance addressed to the model has to know which.
 */
export type ToolSurface = 'mcp' | 'assistant';

/** Per-request context shared by every tool registrar. */
export interface McpToolContext {
  user: AuthenticatedUser;
  scopes: Set<string>;
  allowDestructive: boolean;
  audit: McpAuditRepository;
  /**
   * Whether a person, a plain key or an agent is driving — and which key row.
   *
   * Derived once at the edge of the request (`actorFromRequest`) and carried,
   * not recomputed: the key id is deliberately absent from `AuthenticatedUser`
   * (see CURRENT_API_KEY_ID), so a tool that tried to work it out from the
   * principal would get it wrong. Optional because the assistant surface can be
   * reached from a test harness with no request behind it.
   */
  actor?: Actor;
  /**
   * The Flui API, called over HTTP as the caller's own principal — and the only
   * way a tool reaches anything at all.
   *
   * The guards are decorations on the controllers: `AppAccessGuard`, the sandbox
   * route fence, the section and permission gates sit on the request path and on
   * nothing else, so a service call reached in process walks past every one of
   * them while a real request cannot. There is deliberately no second field
   * holding those services any more — a bypass that is not on the context is one
   * nobody can reach for by accident.
   *
   * The caller is already bound to the credential the inbound request carried:
   * no tool body ever sees a token, and none is minted.
   */
  api: McpApiCaller;
  surface: ToolSurface;
  /**
   * The caller is a sandbox guest. Set on both surfaces so the visibility
   * filter has one place to read it from; it hides tools and grants nothing —
   * every tool still meets the route fence on the way in.
   */
  isSandbox?: boolean;
  /**
   * What the current round of a multi-round-trip call carried (MCP 2026-07-28).
   * Named after the SDK's own `ctx.mcpReq`, and now filled from it: the package
   * lifts `inputResponses`/`requestState` off the wire and hands them to the
   * handler. Absent on a first call, and on the assistant surface, which has no
   * MCP request at all.
   */
  mcpReq?: McpRequestRound;
  /**
   * Seals a correlation payload into the opaque `requestState` a handler hands
   * back with `inputRequired`. Bound per call by `runTool` to the SDK context,
   * because the codec's binding is evaluated against the principal of *this*
   * round — a state minted for one caller is refused when echoed by another.
   *
   * Absent on the assistant surface, which has no MCP request and therefore no
   * round trip through a client to protect.
   */
  mintRequestState?: (payload: unknown) => Promise<string>;
  /**
   * The HMAC codec for `requestState`, keyed by an HKDF subkey of the platform
   * key. Set once per request by the MCP factory; `runTool` binds
   * its `mint` to the round's SDK context. Its `verify` is wired into the
   * server itself, so a tampered or expired state never reaches a handler.
   */
  requestStateCodec?: RequestStateCodec;
}

/**
 * One tool, defined once. The MCP server (external agents) and the Flui Assistant
 * agent loop (in-process) both consume this — name, schema, required scope and the
 * raw business call. Gating/audit lives in the consumer, not the definition.
 */
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  scope: McpScope;
  /**
   * The API route the tool's call is decided on, as a fence pattern
   * (`'POST /applications/:id/deploy'`). Several when the body branches; the
   * preparatory reads a tool makes on the way — resolving the single cluster,
   * reading an application before writing it — are not routes it is *about* and
   * are left out.
   *
   * It is a declaration of where the tool goes, never of what it may do: what a
   * call is allowed to touch stays with the guards on the route. What this
   * buys is the one question that cannot be answered from a closure — *would
   * this principal's request be let through, and would it be answered with the
   * real thing* — which is how `sandbox-tool-visibility.ts` decides what a
   * guest is offered without a second hand-written list beside the fence.
   *
   * Optional in the type and fail-closed in the filter: a tool that declares
   * nothing is not offered to a guest. `wire-catalog.spec.ts` pins each
   * declaration against the call the tool actually makes.
   */
  routes?: string[];
  run: (
    args: z.infer<z.ZodObject<Shape>>,
    ctx: McpToolContext,
  ) => Promise<unknown>;
  /**
   * Optional compact projection fed to the LLM in the agent loop, when the full
   * result is bulky/deterministic (e.g. logs, long lists). The full result still
   * reaches the UI; only the model sees this slimmed view, to spare the context.
   */
  forModel?: (data: unknown) => unknown;
}

/** Identity helper that preserves each tool's argument types at the call site. */
export function defineTool<Shape extends ZodRawShape>(
  def: ToolDef<Shape>,
): ToolDef<Shape> {
  return def;
}

/**
 * The validating form of a tool's input contract, strict on purpose.
 *
 * A permissive object DROPS unknown keys instead of rejecting them, which is the
 * worst possible failure for a model-driven caller: a plausible-but-wrong argument
 * name leaves the real parameter `undefined`, the tool runs unfiltered, and the
 * agent is handed a confident, successful answer to a question it never asked. An
 * explicit rejection costs one turn; a silent one poisons the whole chain.
 */
export function toolInputSchema<Shape extends ZodRawShape>(shape: Shape) {
  const keys = Object.keys(shape);
  const accepted = keys.length ? keys.join(', ') : '(none)';
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      return `Unknown argument(s): ${issue.keys.join(', ')}. Accepted argument(s): ${accepted}.`;
    },
  });
}

// LLM tool-calling often encodes every argument as a string ("true", "200").
// These coerce such values back before validation, keeping the inner constraints.
function asBoolean(v: unknown): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export const coerceBoolean = () => z.preprocess(asBoolean, z.boolean());

export const coerceNumber = (inner: z.ZodNumber) =>
  z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
        ? Number(v)
        : v,
    inner,
  );

/**
 * Resolve the cluster a cluster-scoped tool should act on. An explicit id wins;
 * otherwise, if exactly one cluster exists, it is used automatically (so the model
 * doesn't need a cluster_list round-trip). With zero or several clusters it throws a
 * message the model can act on — the error surfaces as the tool result.
 */
export async function resolveClusterId(
  ctx: McpToolContext,
  clusterId?: string,
): Promise<string> {
  if (clusterId) return clusterId;
  // Over the wire like every other read: `GET /infrastructure/clusters` returns
  // what THIS caller may see, so "exactly one cluster" now means one the caller
  // can act on, not one that merely exists on the instance.
  const clusters = await ctx.api.get<Array<{ id: string; name: string }>>(
    '/infrastructure/clusters',
  );
  if (clusters.length === 1) return clusters[0].id;
  if (clusters.length === 0) {
    throw new Error('No clusters exist yet — create one before querying it.');
  }
  const choices = clusters.map((c) => `${c.name} (${c.id})`).join(', ');
  throw new Error(
    `Several clusters exist — pass clusterId. Available: ${choices}.`,
  );
}

export interface OperationOutcome {
  operationId: string;
  status: string;
  done: boolean;
  error?: string;
  /** Plain-language guidance the model can relay; surface-agnostic (MCP + assistant). */
  note: string;
  /** Human-readable summary, e.g. "Install MariaDB" — the UI shows this on the progress widget. */
  label?: string;
}

function outcomeNote(
  status: string,
  done: boolean,
  surface: ToolSurface,
): string {
  if (status === 'FAILED' || status === 'CANCELLED') {
    return 'The operation FAILED. Tell the user the exact reason in `error` and what to do about it; do NOT retry the same action until that cause is resolved.';
  }
  if (done) {
    return 'The operation completed successfully.';
  }
  // Only the Flui UI polls the operation to a progress widget. Telling an external
  // MCP client the same thing strands the operation: nobody watches it, and a
  // failure 30s later is never surfaced to anyone.
  if (surface === 'assistant') {
    return 'Started — it runs in the background and the user is shown a live progress widget for it, so you do NOT need to wait, re-check, or report completion. Just say it has started; never claim it finished and never promise to notify them.';
  }
  return 'Started in the background. Nothing polls it for you on this surface, so YOU must follow it: call operation_status with this operationId until `done` is true, then report the real outcome. Never claim it finished before `done`.';
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/**
 * The handle of an operation the call that just returned has started.
 *
 * It does NOT read the operation back. The in-process version did — create,
 * then `getOperationDetails` — for one reason only: to build `note`, which is
 * computed from the surface and from whether the status is terminal, and a
 * status that arrived with the creating response is the same status that second
 * read would have found microseconds later. Over HTTP that read would be a
 * second round trip, on a route (`/infrastructure/operations/:id`) that an
 * operator is refused by section — so a successful install would come back to the
 * agent as a failed tool call. Reporting what the API just said is both
 * cheaper and truer.
 *
 * Synchronous preflight failures never reach here: they throw before an
 * operation exists and surface as an inline error.
 */
export function startedOutcome(
  ctx: McpToolContext,
  operationId: string,
  status: string,
  label?: string,
  error?: string,
): OperationOutcome {
  const done = isTerminalStatus(status);
  return {
    operationId,
    status,
    done,
    error,
    note: outcomeNote(status, done, ctx.surface),
    label,
  };
}

/**
 * Remove an installed application by id, routing server-side so the model never has
 * to know how it was created: an app that belongs to a catalog install is removed as
 * the WHOLE install (all components); a custom/source app is deleted on its own.
 * Either removal tool funnels here, so whichever the model picks does the right thing.
 */
export async function removeApplication(
  ctx: McpToolContext,
  applicationId: string,
): Promise<OperationOutcome & { removed: 'catalog-install' | 'application' }> {
  // One call, because the decision has to be atomic. Composed of the routes
  // that already exist it would be four — read the app, read its install, read
  // that install's status, then delete — with the model's own retries and its
  // habit of calling remove once per listed component landing in the gaps. The
  // route makes the read-and-decide one request; see AppRemovalController.
  const outcome = await ctx.api.delete<{
    removed: 'catalog-install' | 'application';
    operationId: string;
    status: string;
    done: boolean;
    alreadyUnderway?: boolean;
    label?: string;
  }>(`/applications/${encodeURIComponent(applicationId)}/install`);

  if (outcome.alreadyUnderway) {
    return {
      removed: outcome.removed,
      operationId: outcome.operationId,
      status: outcome.status,
      done: outcome.done,
      note: outcome.done
        ? 'This app and all its components were already removed.'
        : 'This app is already being removed — all its components go together, so there is nothing more to remove. Do not call remove again for its other components.',
    };
  }
  return {
    removed: outcome.removed,
    ...startedOutcome(ctx, outcome.operationId, outcome.status, outcome.label),
  };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Whether this principal could actually run the tool, were it to call it now. Both
 * conditions are fixed for the life of a request, so a `false` here means "never",
 * not "not yet" — which is what makes it safe to hide the tool rather than offer it.
 */
export function isExecutable(ctx: McpToolContext, def: ToolDef): boolean {
  if (!ctx.scopes.has(def.scope)) return false;
  return SCOPE_TIER[def.scope] !== 'destructive' || ctx.allowDestructive;
}

/**
 * The whole MCP-side execution of one tool: gate, run, project. `forModel` matters
 * more here than in the assistant loop — an MCP client has no UI to receive the full
 * DTO, so the model is the only consumer and the compact view is the right payload.
 */
export function runTool(
  ctx: McpToolContext,
  def: ToolDef,
  args: unknown,
  sdkCtx?: ServerContext,
): Promise<ToolResult | InputRequiredResult> {
  // The round is read per call, not per connection: a retry carrying
  // inputResponses is a different round of the same conversation, and nothing
  // about the principal or its scopes changes with it.
  const scoped: McpToolContext = {
    ...ctx,
    mcpReq: readRound(sdkCtx?.mcpReq),
    mintRequestState:
      ctx.requestStateCodec && sdkCtx
        ? (payload) => ctx.requestStateCodec.mint(payload, sdkCtx)
        : undefined,
  };
  return runGated(
    scoped,
    def.name,
    def.scope,
    async () => {
      const data = await def.run(args as never, scoped);
      return def.forModel && !isInputRequired(data) ? def.forModel(data) : data;
    },
    { args, shape: def.inputSchema },
  );
}

/**
 * What the audit is told about the call, beside its name and its outcome.
 *
 * Optional, and the redactor is fail-closed on its absence: a caller that
 * passes nothing gets a row with no arguments rather than a row with raw ones.
 */
export interface AuditedCall {
  args?: unknown;
  shape?: ZodRawShape;
}

/**
 * Runs a tool body behind the scope gate: refuses if the scope is not granted,
 * refuses destructive tools unless explicitly enabled, audits every outcome.
 */
export async function runGated(
  ctx: McpToolContext,
  tool: string,
  scope: McpScope,
  fn: () => Promise<unknown>,
  call?: AuditedCall,
): Promise<ToolResult | InputRequiredResult> {
  // Redacted once, at the top, and reused by every branch below — a refusal is
  // as worth recording as a success, and more so: "what did it try to do before
  // it was stopped" is the question a revoke decision is made on.
  const args = redactToolArgs(call?.shape, call?.args);

  if (!ctx.scopes.has(scope)) {
    await ctx.audit.record({
      userId: ctx.user.userId,
      actor: ctx.actor,
      args,
      tool,
      scope,
      allowed: false,
      error: 'missing scope',
    });
    // Named as a GRANT problem, because the other refusal an agent meets on
    // this surface — the one the API's own guards raise — is a PERMISSION
    // problem, and an agent that cannot tell them apart tells the user the
    // wrong thing. This one means "the tool was never handed to you"; the other
    // means "you hold the tool but not this resource".
    return errorResult(
      `Refused: missing required scope '${scope}'. This is a GRANT problem, not an access-control one: the agent credential in use does not carry that scope, so no resource will make this call work. Ask for the scope to be granted; do not retry meanwhile.`,
    );
  }

  if (SCOPE_TIER[scope] === 'destructive' && !ctx.allowDestructive) {
    await ctx.audit.record({
      userId: ctx.user.userId,
      actor: ctx.actor,
      args,
      tool,
      scope,
      allowed: false,
      error: 'destructive disabled',
    });
    return errorResult(
      'Refused: destructive operations are disabled on this server (set MCP_ALLOW_DESTRUCTIVE=true to enable).',
    );
  }

  try {
    const data = await fn();
    await ctx.audit.record({
      userId: ctx.user.userId,
      actor: ctx.actor,
      args,
      tool,
      scope,
      allowed: true,
      // A turn that stops to ask a person is otherwise written as
      // `allowed: true, error: null` and reads as a success.
      outcome: isInputRequired(data) ? 'input_required' : null,
      // The handle of whatever was started, and the only thing read back off a
      // result — see startedOperationId for why nothing else is.
      operationId: startedOperationId(data),
    });
    // An input-required return is handed back untouched, which is the whole
    // point of the migration: the 2026-07-28 codec renders it — `resultType`,
    // the embedded requests, the server identity in `_meta` — and `isError`
    // never appears, because waiting for a person is a state and an agent that
    // reads a failure retries. On a 2025-era request the SDK's own legacy shim
    // takes it from here; neither path is ours to re-render.
    return isInputRequired(data) ? data : jsonResult(data);
  } catch (error) {
    // A refusal that came back from the API is not a generic failure and must
    // not read like one. `describeError` would flatten it to "[403] Not allowed
    // to app:read on application 'x'", which loses the two things the agent
    // acts on: that this is the guard and not the scope, and that retrying is
    // pointless. `agentMessage` carries both.
    const message =
      error instanceof McpApiError ? error.agentMessage : describeError(error);
    // The action cycle asking a person is a WAIT, and the protocol has a shape
    // for exactly that. Returning it as `isError` would be the one mistake the
    // multi-round-trip pattern exists to prevent: an agent that reads a failure
    // retries blindly or gives up, and here the right behaviour is neither —
    // it is to stop, say what was asked for, and retry the identical call once
    // the answer exists. The person's click does not execute anything; the
    // retry does, which is what keeps the attribution honest.
    const waiting = error instanceof McpApiError ? error.proposal : undefined;
    await ctx.audit.record({
      userId: ctx.user.userId,
      actor: ctx.actor,
      args,
      tool,
      scope,
      // An access refusal from a guard is not "the tool ran": the scope let it
      // through, the resource did not. Recorded as denied so the audit tells
      // the two refusals apart the same way the agent does.
      allowed: !(error instanceof McpApiError && error.isAccessRefusal),
      outcome: waiting ? 'input_required' : null,
      error: message,
    });
    if (waiting) return proposalElicitation(waiting, message);
    return errorResult(message);
  }
}

/**
 * A pending request, rendered as the protocol's URL elicitation.
 *
 * `elicitUrl` and not a form: what has to happen is a decision on a page that
 * shows the sentence, the estimate and the two-or-three answers — not a field
 * the agent fills in. The URL is the one the API stated in its refusal, so
 * "which page decides a request" is said in one place rather than assembled
 * again here.
 *
 * A client that ignores it loses nothing that matters: the message says the same
 * thing in words, and the wait is a row either way. That is the property that
 * makes this work with `curl`.
 */
function proposalElicitation(
  proposal: ProposalRefusal,
  message: string,
): InputRequiredResult {
  const url =
    proposal.decideUrl ?? `${PROPOSAL_DECISION_PATH}/${proposal.proposalId}`;
  return inputRequired({
    inputRequests: {
      approved: inputRequired.elicitUrl({
        message: `${message}\n\nRequest: ${proposal.sentence}`,
        url,
      }),
    },
  });
}
