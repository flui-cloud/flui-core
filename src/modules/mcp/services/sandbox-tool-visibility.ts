import { ToolDef } from '../tools/mcp-tool.util';
import {
  HttpVerb,
  SandboxLevel,
  sandboxLevelOf,
} from '../../sandbox/constants/sandbox-fence';

/**
 * Which tools a sandbox guest's agent is offered.
 *
 * The list is not written here. It is read off the fence, which already knows
 * both things that matter — and the second one is the half that gets
 * forgotten:
 *
 *  1. **Would the route be refused?** Offering a tool that always comes back
 *     403 costs the agent a turn and the demonstration its credibility.
 *  2. **Would the route be answered from the example world?** `/backup-policies`,
 *     `/mail/readiness` and their neighbours answer a guest `200` with objects
 *     carrying `sandboxExample: true`. A person sees the label on the screen
 *     above them; a model receives a JSON body in which nothing says those
 *     backups do not exist, and tells its user about backups nobody has. For an
 *     agent an invented answer is worse than a refusal.
 *
 * `sandboxLevelOf` answers both from one list, which is why there is no second
 * list to keep in step with it: `closed` is the first question, `stand-in` the
 * second, and only `full` and `read-only` mean "the real thing, and it is
 * yours or it is honestly labelled".
 *
 * This hides; it never grants. Every tool still goes over HTTP as the guest, so
 * a tool that slipped through would still meet the fence and the per-resource
 * guards on the way in.
 */
const REAL = new Set<SandboxLevel>(['full', 'read-only']);

/** A guest gets the real answer on this route — neither refused nor invented. */
export function guestGetsTheRealThing(route: string): boolean {
  const space = route.indexOf(' ');
  if (space < 0) return false;
  const verb = route.slice(0, space).toUpperCase() as HttpVerb;
  const path = route.slice(space + 1);
  return REAL.has(sandboxLevelOf(verb, path));
}

/**
 * Whether this tool is worth offering to a guest.
 *
 * Fail-closed on an undeclared tool, deliberately, and for the same reason the
 * fence stopped using a `/sandbox/**` wildcard: a tool added later is not
 * offered to a guest until somebody has said where it goes. The cost of getting
 * that wrong is a missing tool; the cost of the other default is an agent
 * confidently reporting an example world as the guest's own.
 *
 * A tool that branches is offered when ANY of its branches lands somewhere real
 * — `app_logs` reaches the cluster-wide search a guest may not have and the
 * per-application route it may, and the guest's own logs are the reason it is
 * on the list at all.
 */
export function isOfferedToGuest(def: ToolDef): boolean {
  const routes = def.routes ?? [];
  return routes.some(guestGetsTheRealThing);
}
