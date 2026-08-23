import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { acceptedContent, inputRequired } from '../protocol/mrtr';
import { defineTool, McpToolContext, ToolDef } from './mcp-tool.util';

/**
 * cli_action — the twin of `ui_action` (see repo.tools.ts), pointing at the
 * terminal instead of the browser.
 *
 * Same rule, different destination: the agent never performs the flow itself.
 * It hands the person a command to run on their own machine, and the value
 * travels from their keyboard to encrypted storage without passing through the
 * model, the agent's context, or anybody's shell history.
 */
interface CliAction {
  cliAction: { kind: 'run_command'; command: string; label: string };
  instructions: string;
}

function runCommand(command: string, key: string): CliAction {
  return {
    cliAction: { kind: 'run_command', command, label: `Deliver ${key}` },
    instructions:
      'Relay this command for the person to run in their own terminal. Do not run it yourself, do not fill in a value, and do not ask them to paste the value to you.',
  };
}

/** Path-segment safety: an id from a model is input, not a literal. */
const enc = encodeURIComponent;

/**
 * Seals a correlation payload for the round trip.
 *
 * The codec lives on the MCP surface only. On the assistant surface there is no
 * MCP request and no client to carry a state through, so there is nothing to
 * protect and nothing to sign — the plain encoding stays, and it is still
 * trusted with nothing.
 */
const mintState = async (
  ctx: McpToolContext,
  payload: { app: string; key: string },
): Promise<string> =>
  ctx.mintRequestState
    ? ctx.mintRequestState(payload)
    : JSON.stringify(payload);

interface VariablesView {
  data?: Record<string, unknown>;
  sensitiveKeys?: string[];
  pendingKeys?: string[];
}

function variablesPath(applicationId: string): string {
  return `/variables/applications/${enc(applicationId)}`;
}

function isConfigured(view: VariablesView, key: string): boolean {
  return (
    (view.sensitiveKeys ?? []).includes(key) &&
    !(view.pendingKeys ?? []).includes(key)
  );
}

/**
 * Why the declaration was refused, read back off the view the write returns.
 *
 * The service call this used to make handed back a `skipped[]` with a reason on
 * it; the route answers with the combined view instead. The three reasons the
 * writer can have — the key is linked to a building block, it already exists as
 * a plain variable, it is already configured — are each visible in that view,
 * so nothing is guessed: what is lost is only the exact wording, and a reason
 * derived from the state after the write cannot disagree with the state.
 */
function refusalReason(view: VariablesView, key: string): string | undefined {
  if ((view.pendingKeys ?? []).includes(key)) return undefined;
  if (Object.keys(view.data ?? {}).includes(key)) {
    return 'already set as a plain variable';
  }
  if ((view.sensitiveKeys ?? []).includes(key)) {
    return 'already configured, or supplied by a linked building-block secret';
  }
  return 'not accepted for this application';
}

/**
 * The delivery hand-off, as MRTR (MCP 2026-07-28).
 *
 * Three rules shape every line below, and none of them is negotiable:
 *
 *  1. **the secret is not in the call.** There is no `value` argument here and
 *     there never will be one: an argument would land in the agent's context
 *     and in the shell history of whoever ran it. The elicitation asks the
 *     person to CONFIRM — never to type the value into a field the client
 *     relays back through the model;
 *  2. **it is never read back.** Every result says WHETHER the key is
 *     configured. Nothing on this path can answer WHAT it holds;
 *  3. **"missing a value" is a state, not an error.** The first call returns
 *     `input_required` — `isError` stays off — so an agent parks instead of
 *     retrying. A retry that finds the value still missing returns an ordinary
 *     completed result saying so, which is what stops the loop: repeating
 *     `input_required` forever would be a spin dressed up as a protocol.
 *
 * **On a 2025-era client the pause is rendered by the SDK's legacy shim, and it
 * is not the 2026-07-28 shape**. We accept it rather than fight
 * it: `legacyShim: false` fails loudly instead of degrading, and
 * `legacy: 'reject'` would contradict the decision to keep the 2025 bridge
 * alive. Verified from the wire in round E2 — through the real stdio bridge the
 * turn completes and `requestState` is not surfaced at all, so nothing on that
 * path can be built on the client echoing it back. The tool's own description
 * therefore tells the model to read the note in the payload rather than the
 * shape of the envelope. The day the bridge speaks 2026-07-28 this disappears
 * on its own.
 */
export const VARIABLE_TOOLS: ToolDef[] = [
  defineTool({
    name: 'app_variable_request',
    routes: ['PUT /variables/applications/:appId'],
    description:
      'Ask a PERSON to supply a sensitive variable (a password, an API key, a token) for an application. ' +
      'Use this instead of setting the value yourself: you must never hold, generate, guess or relay a secret. ' +
      'The key is recorded as awaiting a value and the call returns input_required — it has NOT failed, and ' +
      'retrying it unchanged will not help. On an older client this may surface as an ordinary result or an ' +
      'error instead of a pause: read the note in the payload, not the shape of the envelope. Relay the ' +
      'command it hands back so the person can run it locally; ' +
      'the value goes from their terminal straight to encrypted storage and is never shown to you. ' +
      'Reading variables tells you WHICH keys are set and which are still missing, never WHAT any of them is.',
    scope: MCP_SCOPE.APP_WRITE,
    inputSchema: {
      applicationId: z.string(),
      key: z
        .string()
        .describe('The variable name, e.g. STRIPE_SECRET_KEY. Never a value.'),
    },
    run: async (args, ctx) => {
      // Three calls, the same three the in-process version made, and all of
      // them behind `AppAccessGuard`: the application, its variable view, the
      // declaration. Nothing here ever carries a value in either direction.
      const app = await ctx.api.get<{ slug: string }>(
        `/applications/${enc(args.applicationId)}`,
      );
      const command = `flui app env set ${app.slug} ${args.key}`;
      const action = runCommand(command, args.key);

      const before = await ctx.api.get<VariablesView>(
        variablesPath(args.applicationId),
      );
      if (isConfigured(before, args.key)) {
        return {
          key: args.key,
          application: app.slug,
          configured: true,
          note: 'Already configured. The value is not readable from here, by design. If it needs replacing, the person runs the command below themselves.',
          ...action,
        };
      }

      const after = await ctx.api.put<VariablesView>(
        `${variablesPath(args.applicationId)}?type=sensitive`,
        // `data: {}` is required by the route's DTO even for a payload that
        // only declares. It is also exactly what is meant — write no values —
        // and the handler skips the Secret write when it is empty, so nothing
        // is created for an application that has not been deployed yet.
        { data: {}, requestKeys: [args.key] },
      );
      const refused = refusalReason(after, args.key);
      if (refused) {
        // A refusal is still a state: say what it is and stop, rather than
        // throwing, which an agent reads as "try again".
        return {
          key: args.key,
          application: app.slug,
          configured: false,
          requested: false,
          note: `Nothing was recorded: this key is ${refused}.`,
        };
      }

      // A retried call whose value still has not arrived completes plainly.
      // Asking a second time is indistinguishable, from the agent's side, from
      // asking forever.
      if (acceptedContent(ctx.mcpReq?.inputResponses, 'delivered')) {
        return {
          key: args.key,
          application: app.slug,
          configured: false,
          awaitingPerson: true,
          note: 'Still waiting for the person to run the command. This is a state, not a failure: stop here, do not retry, and carry on with everything that does not depend on this value.',
          ...action,
        };
      }

      return inputRequired({
        inputRequests: {
          delivered: inputRequired.elicit({
            message: [
              `${args.key} is recorded as awaiting a value on "${app.slug}".`,
              `A person must run:  ${command}`,
              'The command asks for the value, or reads it from standard input, and sends it straight to encrypted storage.',
              'Confirm once that is done. Do NOT type the value here.',
            ].join('\n'),
            requestedSchema: {
              type: 'object',
              // Deliberately a confirmation, not the secret. A `value` field
              // here would throw away the whole point: the client would carry
              // it back through the agent.
              properties: {
                delivered: {
                  type: 'boolean',
                  title: 'The value has been delivered',
                },
              },
              required: ['delivered'],
            },
          }),
        },
        // Correlation only, and still treated as such. It is now SIGNED — an
        // HMAC codec keyed by an HKDF subkey of the platform key, bound to this
        // principal and expiring in ten minutes — so a state that
        // comes back tampered with, expired, or echoed by somebody else never
        // reaches this handler at all.
        //
        // The rule it obeys has not changed one bit: which application and
        // which key are read from the validated tool arguments on every round,
        // never from here. Signing takes away the sign that said "this looks
        // safe without being it"; it does not promote the state to a source of
        // authority.
        requestState: await mintState(ctx, {
          app: args.applicationId,
          key: args.key,
        }),
      });
    },
  }),
];
