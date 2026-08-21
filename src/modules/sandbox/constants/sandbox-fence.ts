/**
 * What a sandbox guest may call. Everything absent from this list is refused —
 * the fence is an allowlist, not a list of holes to plug, because the surface it
 * guards is 588 routes of which 248 carry no authorization of their own.
 *
 * It is enforced on the route, never in the interface: hiding a button stops a
 * person, not an agent holding the guest's own credential. The same list is
 * served to the guest as "what is disabled here, and why" — see
 * `sandbox-areas.ts`, which must be kept saying what these rules do.
 *
 * The rules themselves are in three files, split by the promise they make:
 * what is the guest's own, what is shown to them for real, and what is answered
 * from the example world. This file only assembles them and answers questions
 * about them; the order it assembles them in carries no meaning, and there is a
 * test that keeps it that way — no path may be matched by two rules that grant
 * different levels.
 */
import {
  HttpVerb,
  SandboxAllowRule,
  SandboxLevel,
  routeMatches,
} from './sandbox-fence-core';
import { SANDBOX_ALLOW_OWN } from './sandbox-fence-own';
import { SANDBOX_ALLOW_SHOWN } from './sandbox-fence-shown';
import { SANDBOX_ALLOW_EXAMPLE } from './sandbox-fence-example';

export {
  HttpVerb,
  SandboxAllowRule,
  SandboxLevel,
  routeMatches,
} from './sandbox-fence-core';
export { SandboxArea, SANDBOX_AREAS } from './sandbox-areas';

export const SANDBOX_ALLOWLIST: SandboxAllowRule[] = [
  ...SANDBOX_ALLOW_OWN,
  ...SANDBOX_ALLOW_SHOWN,
  ...SANDBOX_ALLOW_EXAMPLE,
];

const matching = (verb: string, path: string) =>
  SANDBOX_ALLOWLIST.filter(
    (rule) =>
      rule.verbs.includes(verb.toUpperCase() as HttpVerb) &&
      routeMatches(rule.pattern, path),
  );

export function isSandboxAllowed(verb: string, path: string): boolean {
  return matching(verb, path).length > 0;
}

/** The level a guest gets on a route, for the declaration on the response. */
export function sandboxLevelOf(verb: string, path: string): SandboxLevel {
  const rule = matching(verb, path)[0];
  return rule ? (rule.level ?? 'full') : 'closed';
}

/**
 * Whether this path belongs to an area a guest is shown read-only.
 *
 * Used to answer a write there with the section's own wording rather than the
 * blanket "this is disabled in the sandbox", which contradicts the section open
 * in front of the person reading it.
 */
export function isReadOnlyArea(path: string): boolean {
  return SANDBOX_ALLOW_SHOWN.some((rule) => routeMatches(rule.pattern, path));
}

export const SANDBOX_READ_ONLY_WRITE_CODE = 'SANDBOX_READ_ONLY';

export const SANDBOX_READ_ONLY_WRITE_MESSAGE =
  'You can look at this section here, but not change it. Your own applications and databases are real and yours to change.';
