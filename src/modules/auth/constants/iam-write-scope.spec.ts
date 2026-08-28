import {
  PERMISSION_GROUPS,
  findPermissionGroup,
  groupsForScopes,
} from './api-key-groups';
import { SCOPE_AUTHORITY, SCOPE_REQUIRES_PERMISSION } from './api-key-scopes';
import { credentialCeiling } from '../utils/credential-ceiling.util';
import {
  DEFAULT_SCOPES,
  MCP_SCOPE,
  McpTier,
  TIER_SCOPES,
  expandTier,
} from '../../mcp/constants/mcp-scopes';
import { McpScopeResolver } from '../../mcp/services/mcp-scope.resolver';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';
import { isOfferedToGuest } from '../../mcp/services/sandbox-tool-visibility';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * The condition the author attached to letting an agent confer a delegation
 * (decision 91): the power must be a catalogue entry, and it must be switchable
 * off. Off is the default and switching it on is a gesture — the shape of
 * decision 73.
 *
 * "Off by default" is not a sentence in a comment; it is the absence of
 * `mcp:iam:write` from every path that hands a principal scopes it never asked
 * for. There are four such paths and each one is checked below, because each is
 * a different way the condition could quietly stop holding: a group that starts
 * naming it, a tier list somebody tidies, the platform default, the guest
 * default.
 */
describe('mcp:iam:write — switched off unless somebody switched it on', () => {
  const WRITE = MCP_SCOPE.IAM_WRITE as string;

  it('is a real entry of the catalogue, not a string a tool invented', () => {
    expect(SCOPE_AUTHORITY[MCP_SCOPE.IAM_WRITE]).toBeDefined();
  });

  describe('no group carries it except the one named for it', () => {
    it('is named by exactly one group, and that group is access:change', () => {
      const carriers = PERMISSION_GROUPS.filter((g) =>
        (g.scopes as string[]).includes(WRITE),
      ).map((g) => g.key);
      expect(carriers).toEqual(['access:change']);
    });

    /**
     * The failure this guards against is not "somebody adds it to apps:change"
     * on purpose — it is a deeper group inheriting a shallower one that grew a
     * scope. `apps:destroy` spreads `apps:change`, so one line in the wrong
     * place would hand a delete-applications key the power to grant roles.
     */
    it('is absent from every group in every other area', () => {
      for (const group of PERMISSION_GROUPS) {
        if (group.key === 'access:change') continue;
        expect({
          group: group.key,
          carries: (group.scopes as string[]).includes(WRITE),
        }).toEqual({ group: group.key, carries: false });
      }
    });

    it('leaves the group that only looks unable to change anything', () => {
      expect(
        findPermissionGroup('access:look')!.scopes as string[],
      ).not.toContain(WRITE);
    });

    it('reads back as the group it was switched on with', () => {
      const scopes = [...findPermissionGroup('access:change')!.scopes];
      expect(groupsForScopes(scopes)).toEqual(['access:change']);
    });
  });

  describe('no tier hands it out, which is where "by omission" would come from', () => {
    it.each(['read', 'plan', 'write', 'destructive'] as McpTier[])(
      'is not in the %s tier',
      (tier) => {
        expect(TIER_SCOPES[tier] as string[]).not.toContain(WRITE);
        expect(expandTier(tier) as string[]).not.toContain(WRITE);
      },
    );

    it('is not in the platform default a credential with no scopes falls back to', () => {
      expect(DEFAULT_SCOPES as string[]).not.toContain(WRITE);
    });
  });

  /**
   * The three answers `McpScopeResolver` can give without being told anything,
   * and the one it can only give when it was told.
   *
   * The administrator is the case worth writing down: an unscoped key minted by
   * an admin resolves to the whole destructive tier, so a scope listed there
   * would reach every administrator's agent without anybody choosing it.
   */
  describe('the resolver gives it to nobody who did not ask', () => {
    const resolver = new McpScopeResolver();
    const asUser = (over: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
      ({ userId: 'u1', email: 'a@b.c', ...over }) as AuthenticatedUser;

    it('withholds it from a platform administrator with an unscoped credential', () => {
      const scopes = resolver.resolve(asUser({ isAdmin: true }));
      expect(scopes.has(WRITE)).toBe(false);
      // Not because the administrator gets nothing: they get everything else.
      expect(scopes.has(MCP_SCOPE.APP_DESTRUCTIVE)).toBe(true);
    });

    it('withholds it from an ordinary principal', () => {
      expect(resolver.resolve(asUser()).has(WRITE)).toBe(false);
    });

    it('withholds it from a sandbox guest', () => {
      expect(resolver.resolve(asUser(), true).has(WRITE)).toBe(false);
    });

    it('hands it over when, and only when, the credential names it', () => {
      const scopes = resolver.resolve(asUser({ scopes: [WRITE] }));
      expect(scopes.has(WRITE)).toBe(true);
    });

    /**
     * The second source the ceiling reads (decision 101): a project role named
     * `mcp:iam:write` in the identity provider. It is the same switch seen from
     * the other side, and it must behave identically — a ceiling that answered
     * differently depending on where the scope came from would be two rules.
     */
    it('accepts it from an identity-provider role exactly as from a key', () => {
      const scopes = resolver.resolve(asUser({ roles: { [WRITE]: {} } }));
      expect(scopes.has(WRITE)).toBe(true);
    });
  });

  describe('what it costs to hand out, and what it is worth once held', () => {
    it('cannot be conferred by anybody who does not administer access', () => {
      expect(SCOPE_REQUIRES_PERMISSION[MCP_SCOPE.IAM_WRITE]).toBe(
        IAM_PERMISSION.IAM_ASSIGN_ROLE,
      );
    });

    /**
     * The whole guarantee in one assertion: the permission an agent needs to
     * confer a delegation is the permission its owner had to hold to hand the
     * scope over. The ceiling cannot exceed the mint, so an agent cannot confer
     * what its owner does not have.
     */
    it('carries the one permission it required, and nothing else', () => {
      expect([...credentialCeiling({ scopes: [WRITE] })!]).toEqual([
        IAM_PERMISSION.IAM_ASSIGN_ROLE,
      ]);
    });

    it('does not carry the power to create or delete people', () => {
      expect(SCOPE_AUTHORITY[MCP_SCOPE.IAM_WRITE].allows).not.toContain(
        IAM_PERMISSION.IAM_MANAGE_USERS,
      );
    });
  });

  describe('the tools it unlocks, named so a new one cannot arrive quietly', () => {
    const onWrite = ALL_TOOLS.filter((t) => (t.scope as string) === WRITE).map(
      (t) => t.name,
    );

    /**
     * `user_invite_request` is the third, and it belongs here for a reason the
     * two assertions above already state: it *reads* the account list, which is
     * gated on `iam:assign-role` and is exactly what this scope carries, and it
     * cannot invite anybody, because inviting is gated on `iam:manage-users`
     * and this scope deliberately does not carry that. It hands the invitation
     * to a person instead. A tool that could both look and invite would not
     * belong on this scope, and would fail the assertion above rather than this
     * one.
     */
    it('unlocks the conferral, the revocation, and the invitation hand-off', () => {
      expect([...onWrite].sort()).toEqual([
        'access_grant_add',
        'access_grant_remove',
        'user_invite_request',
      ]);
    });

    it('offers neither of them to a sandbox guest', () => {
      for (const name of onWrite) {
        const def = ALL_TOOLS.find((t) => t.name === name)!;
        expect({ name, offered: isOfferedToGuest(def) }).toEqual({
          name,
          offered: false,
        });
      }
    });
  });
});
