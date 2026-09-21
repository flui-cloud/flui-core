/**
 * What to do when a deploy names a repository this installation does not hold.
 *
 * Connecting a repository is deliberately a conscious act — the import route
 * carries an ActionCycle whose every call asks, because it deposits a
 * credential that can read someone's code. So this never connects on its own.
 *
 * What it removes is the guessing: today the deploy says "connect it first" and
 * stops, whether the token can see the repository or cannot. Those are two
 * different problems and only one of them is solved by running another command.
 */
export type RepoConnectionVerdict =
  /** The token sees it. Ask, then connect and carry on. */
  | { kind: 'offer'; repo: string }
  /** The token cannot see it. Another command will not help. */
  | { kind: 'unreachable'; repo: string; message: string }
  /** Nothing to ask on: say what to run and stop, as before. */
  | { kind: 'instruct'; repo: string; message: string };

export interface ConnectionContext {
  /** Full names the GitHub credential can reach, as `/repositories/available` lists them. */
  readonly available: readonly string[];
  /** False for `--non-interactive` or a pipe: there is nobody to ask. */
  readonly canAsk: boolean;
  /** Set when the listing itself failed; the verdict must not pretend to know. */
  readonly listingError?: string;
}

/**
 * Decides without doing. Kept apart from the command so the branch that matters
 * — the token that cannot see the repository — is testable without a network.
 */
export function judgeMissingConnection(
  repo: string,
  context: ConnectionContext,
): RepoConnectionVerdict {
  if (context.listingError) {
    return {
      kind: 'instruct',
      repo,
      message:
        `Could not ask GitHub which repositories your token reaches (${context.listingError}). ` +
        `Run \`flui repo connect ${repo}\` to import it.`,
    };
  }

  const reachable = context.available.some(
    (name) => name.toLowerCase() === repo.toLowerCase(),
  );

  if (!reachable) {
    return {
      kind: 'unreachable',
      repo,
      message:
        `Your GitHub credential on this installation cannot see "${repo}". ` +
        `Connecting it will not help until the credential reaches it — check that the token ` +
        `has access to that repository, or run \`flui integration connect github\` to replace it.`,
    };
  }

  if (!context.canAsk) {
    return {
      kind: 'instruct',
      repo,
      message:
        `"${repo}" is not connected to this installation. Your token reaches it, so ` +
        `\`flui repo connect ${repo}\` will import it.`,
    };
  }

  return { kind: 'offer', repo };
}
