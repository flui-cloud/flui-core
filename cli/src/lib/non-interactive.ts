/**
 * Headless mode for `flui env create`.
 *
 * The command has several points where it stops and asks — the admin email, the
 * provider setup wizard, and the server-type fallback prompts. Those prompts
 * fire even with no TTY attached, so an automated caller does not fail: it
 * hangs, holding whatever cloud resources it had already created.
 *
 * With `--non-interactive` (or `FLUI_NON_INTERACTIVE=1`) every would-be prompt
 * becomes an immediate, explanatory error naming the flag that would have
 * supplied the answer.
 */
export class NonInteractiveError extends Error {
  constructor(
    readonly question: string,
    readonly remedy: string,
  ) {
    super(
      `Cannot continue without input: ${question}\n` +
        `Running non-interactively, so nothing can be asked. ${remedy}`,
    );
    this.name = 'NonInteractiveError';
  }
}

let nonInteractive = process.env.FLUI_NON_INTERACTIVE === '1';

export function setNonInteractive(value: boolean): void {
  nonInteractive = value;
}

export function isNonInteractive(): boolean {
  return nonInteractive;
}

/**
 * Call immediately before any prompt. In interactive mode it does nothing; in
 * headless mode it throws instead of letting the process block forever.
 */
export function refuseToAsk(question: string, remedy: string): void {
  if (nonInteractive) throw new NonInteractiveError(question, remedy);
}
