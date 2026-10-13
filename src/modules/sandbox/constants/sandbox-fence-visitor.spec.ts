import {
  SANDBOX_ALLOWLIST,
  isSandboxAllowed,
  isVisitorWritable,
} from './sandbox-fence';
import { SANDBOX_ALLOW_GIT } from './sandbox-fence-git';

/**
 * A visitor who has not signed in reads everything a guest reads and writes
 * only what a rule marks for it. These pin which writes those are, and that
 * none of them deploys, installs, connects a repository or keeps anything.
 */
describe('what a visitor may write', () => {
  const visitorRules = SANDBOX_ALLOWLIST.filter((r) => r.visitor === true);

  it('names exactly the writes an agent and the assistant need to look around', () => {
    const named = visitorRules.flatMap((r) =>
      r.verbs.map((v) => `${v} ${r.pattern}`),
    );
    expect(named.sort()).toEqual(
      [
        'POST /auth/oidc-session',
        'POST /catalog/validate',
        'POST /sandbox/visitor/**',
        'POST /auth/api-keys',
        'DELETE /auth/api-keys/:id',
        'POST /assistant/v1/agent',
        'POST /assistant/v1/agent/stream',
        'POST /auth/agent-skill/check-in',
        'POST /mcp',
      ].sort(),
    );
  });

  it('marks only writes, since every read is already a visitor’s', () => {
    for (const rule of visitorRules) {
      expect({ pattern: rule.pattern, verbs: rule.verbs }).toEqual({
        pattern: rule.pattern,
        verbs: rule.verbs.filter((v) => v !== 'GET'),
      });
      expect(rule.level ?? 'full').toBe('full');
    }
  });

  it('opens nothing of the git entrance to a visitor', () => {
    expect(SANDBOX_ALLOW_GIT.filter((r) => r.visitor)).toEqual([]);
  });

  it.each([
    ['POST', '/clusters/:clusterId/applications'],
    ['POST', '/catalog/:slug/install'],
    ['POST', '/applications/deploy-from-yaml'],
    ['POST', '/applications/:id/deploy'],
    ['PATCH', '/applications/:id'],
    ['DELETE', '/applications/:id'],
    ['PUT', '/variables/applications/:appId'],
    ['POST', '/templates/:framework/use'],
    ['POST', '/repositories/github/connect-pat'],
    ['POST', '/repositories/import'],
    ['POST', '/repositories/:id/map/apply'],
    ['POST', '/sandbox/keep'],
    ['POST', '/agent/proposals/:id/decide'],
    ['DELETE', '/agent/concessions/:id'],
  ])('keeps %s %s a guest’s and asks a visitor to sign in', (verb, route) => {
    expect(isSandboxAllowed(verb, route, true)).toBe(true);
    expect(isVisitorWritable(verb, route, true)).toBe(false);
  });

  it('keeps deploying, installing and keeping closed to visitors, whatever is added later', () => {
    const forbidden =
      /deploy|install|keep|repositories|templates|proposals|concessions|applications/;
    for (const rule of visitorRules) {
      expect({
        pattern: rule.pattern,
        forbidden: forbidden.test(rule.pattern),
      }).toEqual({
        pattern: rule.pattern,
        forbidden: false,
      });
    }
  });
});

describe('a visitor turning its visit into an account', () => {
  it.each([
    ['GET', '/sandbox/visitor/upgrade/providers'],
    ['POST', '/sandbox/visitor/upgrade/idp'],
    ['POST', '/sandbox/visitor/upgrade/finish'],
    ['POST', '/sandbox/visitor/link-intent'],
    ['POST', '/sandbox/visitor/link'],
  ])('lets a guest and a visitor reach %s %s', (verb, path) => {
    expect(isSandboxAllowed(verb, path, true)).toBe(true);
    if (verb !== 'GET') expect(isVisitorWritable(verb, path, true)).toBe(true);
  });
});
