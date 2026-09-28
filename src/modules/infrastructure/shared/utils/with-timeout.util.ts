/**
 * Null on timeout, which is the same answer as any other failure to ask: the
 * caller already has to tell "could not ask" apart from "nothing is there",
 * and a slow cluster or provider is not a quiet one either.
 *
 * The work itself is not cancelled: it runs to its end and its answer is
 * dropped, so this bounds how long a caller waits, not what the work costs.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work
      .then((value) => resolve(value))
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timer));
  });
}
