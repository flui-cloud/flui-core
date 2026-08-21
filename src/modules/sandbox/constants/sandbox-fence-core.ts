/**
 * The vocabulary the fence is written in: what a rule looks like, how much of an
 * area it opens, and how a pattern is matched against a path.
 *
 * It sits on its own so the three lists of rules and the questions asked of them
 * can live in separate files without importing each other in a circle. Nothing
 * here decides anything — it is the shape the decisions are written in.
 */

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How much of an area a guest gets. The interface renders the level as a
 * standing label on the section — never as an error.
 *
 * A limit is a product decision, and a product decision is told in a caption. An
 * alarm in the middle of the page says something broke, and worse, it lies: a
 * visitor who reads "Databases disabled" concludes Flui cannot do databases,
 * when in their own space it can.
 */
export type SandboxLevel = 'full' | 'read-only' | 'stand-in' | 'closed';

export interface SandboxAllowRule {
  verbs: HttpVerb[];
  /** Route pattern; `:param` matches one segment, `**` matches the rest. */
  pattern: string;
  why: string;
  /** Defaults to `full` — the guest's own things, with no difference. */
  level?: SandboxLevel;
}

const SEGMENTS = (path: string): string[] =>
  path.split('/').filter((s) => s.length > 0);

/** `:param` matches one segment, `**` matches the remainder (at least one). */
export function routeMatches(pattern: string, path: string): boolean {
  const p = SEGMENTS(pattern);
  const t = SEGMENTS(path);

  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return t.length > i;
    if (i >= t.length) return false;
    if (p[i].startsWith(':')) continue;
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
