import { IamSelector } from '../../iam/interfaces/iam.types';

/**
 * The selector axes an agent is handed, named one by one.
 *
 * Every one of them describes a *resource* by a property of its own: what it
 * is, what it is called, where it runs, which project it belongs to, how it is
 * tagged. `owner` is the one axis of a selector that describes a **person**,
 * and it is the one left out — see {@link selectorForAgent}.
 */
export const AGENT_SELECTOR_AXES = [
  'slugs',
  'type',
  'kind',
  'clusterId',
  'clusterName',
  'provider',
  'project',
  'tags',
] as const;

export interface AgentSelector {
  /** The axes above, as they were written. `null` when the note constrains none. */
  selector: IamSelector | null;
  /**
   * The note follows one principal's resources, and whose is withheld.
   *
   * Kept as a fact rather than dropped with the axis, because dropping it
   * silently turns `{owner: 'u1'}` into `{}` — and an empty selector reads as
   * *this applies to everything*, which is a wider claim than the note makes.
   */
  pinnedToAnOwner: boolean;
}

/**
 * A note's selector as an agent may be told it.
 *
 * The reach test has already run by the time this is called: what is here is a
 * note that reaches the caller. The narrowing is about something else — what
 * the *permissive* half of that test lets through.
 *
 * `reachesFrom` over-approximates on purpose: a grant that leaves an axis
 * undefined meets every value of it. So a grant following `{kind: 'postgres'}`
 * reaches a practice note written on `{owner: '<somebody else>'}`, which is
 * correct — the practice does apply to postgres work — but handing the selector
 * over verbatim would also tell that caller *which principal* the note follows.
 * That is an identity fact about a third party, arriving through a delivery
 * built to describe resources, and the restrictive half (`covers`) would have
 * refused this reader outright. No other delivered field opens it: `scopeRef`
 * names a cluster, the body is prose whoever wrote it knew would descend.
 *
 * So the axis is withheld and its absence is declared. An allow-list and not a
 * subtraction, in the same shape the delivery itself uses: a selector axis
 * added to the IAM types later stays out of a model's context until somebody
 * puts it here on purpose.
 */
export function selectorForAgent(
  selector: IamSelector | null | undefined,
): AgentSelector {
  if (!selector) return { selector: null, pinnedToAnOwner: false };
  const out: IamSelector = {};
  for (const axis of AGENT_SELECTOR_AXES) {
    const value = selector[axis];
    if (value !== undefined) (out[axis] as unknown) = value;
  }
  return {
    selector: Object.keys(out).length ? out : null,
    pinnedToAnOwner: selector.owner !== undefined,
  };
}
