import {
  IDP_AGENT_SCOPE_ROLES,
  IDP_COARSE_ROLES,
  IDP_PROJECT_ROLES,
  idpRoleBindings,
  isAgentScopeKey,
} from './idp-role-source';
import {
  ASSIGNABLE_ROLE_KEYS,
  BUILTIN_ROLES,
  IAM_ROLE,
  ROLE_LADDER,
} from '../constants/iam-roles';
import { GRANTABLE_SCOPES } from '../../auth/constants/api-key-scopes';
import { MCP_SCOPE_PREFIX } from '../../auth/utils/credential-ceiling.util';

/** The claim shape Zitadel puts in a token: roleKey → { orgId: domain }. */
const claim = (...keys: string[]): Record<string, Record<string, string>> =>
  Object.fromEntries(keys.map((k) => [k, { org: 'flui.local' }]));

describe('the identity provider as a source of role', () => {
  describe('the boundary — what can travel and what cannot', () => {
    /**
     * The load-bearing one. Everything else in this file is a consequence.
     */
    it('can only ever produce global bindings with no selector', () => {
      const bindings = idpRoleBindings(claim(...ASSIGNABLE_ROLE_KEYS));
      expect(bindings).toHaveLength(ASSIGNABLE_ROLE_KEYS.length);
      for (const b of bindings) {
        expect(b.scopeType).toBe('global');
        expect(b.scopeRef).toBeNull();
        expect(b.selector).toBeNull();
      }
    });

    it('refuses the two roles whose whole meaning is a selector', () => {
      expect(idpRoleBindings(claim(IAM_ROLE.SANDBOX))).toEqual([]);
      expect(idpRoleBindings(claim(IAM_ROLE.SHOWCASE_VIEWER))).toEqual([]);
    });

    /**
     * Not a restatement of the test above: that one names two roles, this one
     * says the rule those two follow, so a third unassignable role added later
     * is refused without anybody remembering to add a case.
     */
    it('refuses every non-assignable role, by rule and not by name', () => {
      const unassignable = Object.values(BUILTIN_ROLES).filter(
        (r) => !r.assignable,
      );
      expect(unassignable.length).toBeGreaterThan(0);
      for (const role of unassignable) {
        expect(idpRoleBindings(claim(role.key))).toEqual([]);
      }
    });

    it('accepts exactly the four rungs of the ladder', () => {
      expect(ASSIGNABLE_ROLE_KEYS).toEqual(ROLE_LADDER);
      for (const rung of ROLE_LADDER) {
        expect(idpRoleBindings(claim(rung))).toEqual([
          { role: rung, scopeType: 'global', scopeRef: null, selector: null },
        ]);
      }
    });

    it('ignores anything it does not recognise, including near misses', () => {
      const noise = claim(
        'admin',
        'user',
        'readonly',
        'Owner',
        'owner ',
        'iam:manage-users',
        '',
        'sandbox_guest',
      );
      expect(idpRoleBindings(noise)).toEqual([]);
    });
  });

  describe('the two IdP vocabularies do not overlap each other', () => {
    it('no rung is readable as an agent scope, and no agent scope as a rung', () => {
      for (const rung of ASSIGNABLE_ROLE_KEYS) {
        expect(isAgentScopeKey(rung)).toBe(false);
      }
      for (const scope of GRANTABLE_SCOPES) {
        expect(isAgentScopeKey(scope)).toBe(true);
        expect(idpRoleBindings(claim(scope))).toEqual([]);
      }
    });

    it('a claim carrying both is split, never merged', () => {
      const bindings = idpRoleBindings(
        claim('operator', 'mcp:app:write', 'mcp:app:read'),
      );
      expect(bindings.map((b) => b.role)).toEqual(['operator']);
    });

    it('every provisioned key belongs to exactly one of the two halves', () => {
      const keys = IDP_PROJECT_ROLES.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        const isRung = ASSIGNABLE_ROLE_KEYS.includes(key as never);
        expect(isRung).not.toBe(isAgentScopeKey(key));
      }
    });
  });

  describe('no provider, no change', () => {
    it('answers nothing for the empty claim both local strategies populate', () => {
      expect(idpRoleBindings({})).toEqual([]);
      expect(idpRoleBindings(undefined)).toEqual([]);
      expect(idpRoleBindings(null)).toEqual([]);
    });
  });

  describe('the vocabulary Flui writes into the provider', () => {
    /**
     * The sentinel for the drift this file was written to end: the list that
     * used to live in `oidc-bootstrap.service.ts` named six of thirteen scopes,
     * so seven were readable by Flui and unexpressible in the provider.
     */
    it('carries one role per grantable MCP scope — all of them', () => {
      expect(IDP_AGENT_SCOPE_ROLES.map((r) => r.key)).toEqual([
        ...GRANTABLE_SCOPES,
      ]);
    });

    it('carries one role per assignable rung — and no others', () => {
      expect(IDP_COARSE_ROLES.map((r) => r.key)).toEqual([
        ...ASSIGNABLE_ROLE_KEYS,
      ]);
    });

    it('gives every provisioned role a display name', () => {
      for (const role of IDP_PROJECT_ROLES) {
        expect(role.displayName.trim().length).toBeGreaterThan(0);
        expect(role.displayName).not.toContain(MCP_SCOPE_PREFIX);
      }
    });
  });
});
