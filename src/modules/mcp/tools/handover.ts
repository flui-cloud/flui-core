/**
 * The hand-off, in one place.
 *
 * A credential must reach Flui without passing through the model, the agent's
 * context, or anybody's shell history. The agent's job is therefore never to
 * *carry* the value — it is to say precisely what the person should do, and to
 * report afterwards whether the thing is configured, never what it holds.
 *
 * Two destinations, and the difference is only where the person's hands go:
 *
 *  - **`cliAction`** — a command they run in their own terminal. The command
 *    prompts, or reads standard input; it never takes the value as an argument
 *    (see `cli/src/lib/secret-input.ts`, which is what makes that true rather
 *    than aspirational);
 *  - **`uiAction`** — a page they open in their browser, for flows that are a
 *    redirect or a form on somebody else's site.
 *
 * These shapes were written twice — once in `variables.tools.ts` for the
 * terminal and once in `repo.tools.ts` for the browser — and were about to be
 * written a third time. Both surfaces already consume the same result: the MCP
 * host renders it as text, the dashboard as a button.
 */

/** A command the person runs themselves. The agent relays it, never runs it. */
export interface CliAction {
  cliAction: { kind: 'run_command'; command: string; label: string };
  instructions: string;
}

/** A page the person opens. The URL is generated server-side, never by a model. */
export interface UiOpenUrlAction {
  uiAction: { kind: 'open_url'; url?: string; label: string };
  instructions: string;
}

/** A form the person confirms on somebody else's site (a GitHub App manifest). */
export interface UiSubmitFormAction {
  uiAction: {
    kind: 'submit_form';
    url: string;
    fields: Record<string, string>;
    label: string;
  };
  instructions: string;
}

/**
 * The standing instruction attached to every relayed command.
 *
 * Three prohibitions, and each one closes a way the ceremony could be performed
 * and still leak: running it yourself puts the credential in the agent's
 * process, filling in a value puts it in the agent's context, and asking the
 * person to paste it back puts it in the transcript.
 */
export const RELAY_ONLY =
  'Relay this command for the person to run in their own terminal. Do not run it yourself, do not fill in a value, and do not ask them to paste the value to you.';

export function runCommand(command: string, label: string): CliAction {
  return {
    cliAction: { kind: 'run_command', command, label },
    instructions: RELAY_ONLY,
  };
}

/**
 * A destination whose person-verb is a screen, for which no URL can be built
 * here.
 *
 * The tool surface reaches the product only through the API as the caller, and
 * the API does not hand back its own public origin — the two flows that *do*
 * return a URL (`github_setup`, `github_connect`) get it from the route,
 * because it points at GitHub. Rather than assemble an address out of guesses,
 * these say which screen, in the product's own words for it.
 *
 * This is a declared gap, not a design: the day a route answers with the
 * instance's own origin, these become `uiAction`s like the others and nothing
 * else about them changes.
 */
export interface SectionHandover {
  where: string;
  instructions: string;
}

export function inTheDashboard(section: string, what: string): SectionHandover {
  return {
    where: section,
    instructions:
      `A person does this in the dashboard, under ${section}: ${what}. ` +
      'There is no command for it, so relay where to go — do not ask them for the value, ' +
      'and do not attempt it yourself.',
  };
}
