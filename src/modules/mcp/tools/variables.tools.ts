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

async function isConfigured(
  ctx: McpToolContext,
  applicationId: string,
  key: string,
): Promise<boolean> {
  const view =
    await ctx.services.appConfig.getAppVariablesCombined(applicationId);
  return view.sensitiveKeys.includes(key) && !view.pendingKeys.includes(key);
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
 */
export const VARIABLE_TOOLS: ToolDef[] = [
  defineTool({
    name: 'app_variable_request',
    description:
      'Ask a PERSON to supply a sensitive variable (a password, an API key, a token) for an application. ' +
      'Use this instead of setting the value yourself: you must never hold, generate, guess or relay a secret. ' +
      'The key is recorded as awaiting a value and the call returns input_required — it has NOT failed, and ' +
      'retrying it unchanged will not help. Relay the command it hands back so the person can run it locally; ' +
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
      const app = await ctx.services.apps.findById(args.applicationId);
      const command = `flui app env set ${app.slug} ${args.key}`;
      const action = runCommand(command, args.key);

      if (await isConfigured(ctx, args.applicationId, args.key)) {
        return {
          key: args.key,
          application: app.slug,
          configured: true,
          note: 'Already configured. The value is not readable from here, by design. If it needs replacing, the person runs the command below themselves.',
          ...action,
        };
      }

      const { skipped } = await ctx.services.appConfig.requestAppSecrets(
        args.applicationId,
        [args.key],
      );
      const refused = skipped.find((entry) => entry.name === args.key);
      if (refused) {
        // A refusal is still a state: say what it is and stop, rather than
        // throwing, which an agent reads as "try again".
        return {
          key: args.key,
          application: app.slug,
          configured: false,
          requested: false,
          note: `Nothing was recorded: this key is ${refused.reason}.`,
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
        // Correlation only, and treated as such. MRTR state travels through the
        // client, so on the way back it is input controlled by the other side.
        // This server does NOT sign or verify it — the seam hands it back raw
        // on purpose — so it is given no authority at all: which application
        // and which key are read from the
        // validated tool arguments on every round, never from here. The day it
        // is consulted to decide what gets written, it must be signed first.
        requestState: JSON.stringify({
          app: args.applicationId,
          key: args.key,
        }),
      });
    },
  }),
];
