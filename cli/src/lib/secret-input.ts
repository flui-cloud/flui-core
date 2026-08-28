import { stdinRequested, stdinValue } from './stdin-value';

/**
 * How a command takes a secret from the person in front of it.
 *
 * The rule this exists to enforce is already written down elsewhere in the
 * product — the delivery hand-off on the MCP surface states that a credential
 * must travel "from their keyboard to encrypted storage without passing through
 * the model, the agent's context, or anybody's shell history". Two of the CLI's
 * own commands broke the last clause: `mail connect` took `--secret`, and
 * `backup destination create` took `--access-key`, `--secret-key` and
 * `--encryption-passphrase`, all as required flags.
 *
 * A flag is not a private channel. It lands in `~/.zsh_history`, it is visible
 * in `ps` to every other account on the machine for as long as the process
 * lives, and on a shared box it outlives the terminal it was typed in. `flui app
 * env set` had the right shape from the start — prompt, or read standard input —
 * and this is that shape, extracted so the rest of the CLI can hold it too.
 *
 * **The flags survive on purpose.** Removing them would break every script that
 * already drives these commands, and a person who has decided to accept the
 * history entry is entitled to. What changes is that they stop being *required*,
 * and stop being what the examples teach.
 */

/** Reads a secret without echoing it, and without it appearing in `argv`. */
export type MaskedReader = (message: string) => Promise<string>;

/**
 * Loaded on the branch that needs it, not at module load.
 *
 * `prompts` pulls in chalk 5, which is ESM, and the test runner cannot parse it
 * — importing it up here would make this module untestable and the rule it
 * carries unprovable. Every test supplies its own reader, so this line never
 * runs under jest; at the terminal it resolves exactly once.
 */
async function askAtTheTerminal(message: string): Promise<string> {
  const { promptMaskedInput } = await import('./prompts');
  return promptMaskedInput(message);
}

export interface SecretAsk {
  /** Shown at the prompt. Name the credential, not the field. */
  label: string;
  /** The flag value, when the caller passed one. Empty and absent are the same. */
  provided?: string;
  /**
   * Whether `--stdin` may answer this one.
   *
   * At most one ask per command may set it. Standard input is a single stream:
   * a command needing two secrets cannot read both from it, and pretending
   * otherwise would silently give the second one the first one's value.
   */
  fromStdin?: boolean;
}

/**
 * The secret, from the first source that has it: the flag, then `--stdin`, then
 * the person.
 *
 * Order matters and is not arbitrary. The flag wins because an explicit
 * argument is a decision already taken — re-prompting over it would ignore the
 * caller. `--stdin` comes next because it is the scripted path that does *not*
 * leak. The prompt is last because it is the only one that can ask.
 */
export async function readSecret(
  ask: SecretAsk,
  read: MaskedReader = askAtTheTerminal,
): Promise<string> {
  const provided = ask.provided?.trim();
  if (provided) return provided;

  if (ask.fromStdin && stdinRequested()) {
    const piped = stdinValue().trim();
    if (piped) return piped;
  }

  return (await read(ask.label)).trim();
}

/**
 * Several secrets, in the order given, refusing an ambiguous `--stdin`.
 *
 * The refusal is the point. Two asks both claiming standard input is a
 * programming error in the command, not a user error, and it must surface while
 * somebody can still fix it rather than becoming a credential quietly written
 * into the wrong field.
 */
export async function readSecrets(
  asks: SecretAsk[],
  read: MaskedReader = askAtTheTerminal,
): Promise<string[]> {
  if (asks.filter((a) => a.fromStdin).length > 1) {
    throw new Error(
      'Only one secret per command can be read from standard input: it is a single stream.',
    );
  }
  const values: string[] = [];
  for (const ask of asks) values.push(await readSecret(ask, read));
  return values;
}

/**
 * The sentence a secret-taking flag carries in `--help`.
 *
 * Written once because the reason is the same everywhere, and because a warning
 * printed at runtime would fire on every scripted run — noise where the person
 * has already chosen. The place to say it is where somebody is reading about
 * the option, deciding.
 */
export const SECRET_FLAG_NOTE =
  'Prefer leaving this out: the value is then prompted for and never enters your shell history or `ps` output.';
