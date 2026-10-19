import { ALL_TOOLS } from '../tools/tool-registry';
import { SCOPE_TIER } from '../constants/mcp-scopes';
import {
  HttpVerb,
  SandboxLevel,
  routeMatches,
  sandboxLevelOf,
} from '../../sandbox/constants/sandbox-fence';
import { SANDBOX_ALLOW_OWN } from '../../sandbox/constants/sandbox-fence-own';

/**
 * Every tool in the registry, measured against the fence.
 *
 * For a guest the fence is the boundary for the whole registry, not only for
 * the tools it is shown.
 * This pins that the fence has an answer for every route any tool declares,
 * and that no tool can write anywhere a guest does not own.
 */
const LEVELS: SandboxLevel[] = ['full', 'read-only', 'stand-in', 'closed'];

const routesOf = ALL_TOOLS.flatMap((def) =>
  (def.routes ?? []).map((route) => {
    const space = route.indexOf(' ');
    const verb = route.slice(0, space).toUpperCase() as HttpVerb;
    const path = route.slice(space + 1);
    return { tool: def.name, tier: SCOPE_TIER[def.scope], verb, path, route };
  }),
);

const guestOwns = (verb: HttpVerb, path: string) =>
  SANDBOX_ALLOW_OWN.some(
    (rule) => rule.verbs.includes(verb) && routeMatches(rule.pattern, path),
  );

describe('the fence, asked about every tool in the registry', () => {
  it('has a declared route for every tool', () => {
    expect(
      ALL_TOOLS.filter((d) => !d.routes?.length).map((d) => d.name),
    ).toEqual([]);
  });

  it('classifies every declared route', () => {
    for (const r of routesOf) {
      expect(LEVELS).toContain(sandboxLevelOf(r.verb, r.path));
    }
  });

  it('closes every write a guest does not own', () => {
    const open = routesOf.filter(
      (r) =>
        r.verb !== 'GET' &&
        sandboxLevelOf(r.verb, r.path) !== 'closed' &&
        !guestOwns(r.verb, r.path),
    );
    expect(open.map((r) => `${r.tool}: ${r.route}`)).toEqual([]);
  });

  it('closes every route of a destructive tool except the guest’s own', () => {
    const open = routesOf.filter(
      (r) =>
        r.tier === 'destructive' &&
        sandboxLevelOf(r.verb, r.path) !== 'closed' &&
        !guestOwns(r.verb, r.path),
    );
    expect(open.map((r) => `${r.tool}: ${r.route}`)).toEqual([]);
  });

  /**
   * Tools on a read tier whose declared route is a write. They run without a
   * confirmation in the assistant, so each one must be either closed to a
   * guest or one of the guest's own non-mutating POSTs. Listed so a new one
   * is a decision, not an accident.
   */
  it('knows every read-tier tool that declares a write route', () => {
    const readWrites = routesOf
      .filter((r) => r.tier === 'read' && r.verb !== 'GET')
      .map((r) => `${r.tool} ${r.route} → ${sandboxLevelOf(r.verb, r.path)}`)
      .sort((a, b) => a.localeCompare(b));
    expect(readWrites).toEqual(
      [
        'app_manifest_validate POST /applications/manifest/validate → full',
        'credential_scope_request PATCH /auth/api-keys/:id/scopes → closed',
        'get_started POST /auth/agent-skill/check-in → full',
        'github_setup POST /repositories/github/setup/github-app/manifest-start → closed',
        'repo_map POST /repositories/:id/map → full',
        'scaling_cost POST /infrastructure/clusters/:clusterId/scaling/cost → closed',
      ].sort((a, b) => a.localeCompare(b)),
    );
  });
});
