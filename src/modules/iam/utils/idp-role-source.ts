import { IamBinding } from '../interfaces/iam.types';
import {
  ASSIGNABLE_ROLE_KEYS,
  BUILTIN_ROLES,
  IamRole,
} from '../constants/iam-roles';
import { MCP_SCOPE_PREFIX } from '../../auth/utils/credential-ceiling.util';
import { GRANTABLE_SCOPES } from '../../auth/constants/api-key-scopes';

/**
 * The identity provider as a *second* source of role, beside Flui's own
 * bindings — never as the only one, and never as the same kind of statement.
 *
 * ── The boundary, and why it cannot be crossed ────────────────────────────
 *
 * The provider knows *who you are*; it does not know what exists inside Flui.
 * "This person is a maintainer" is a fact about an identity and travels. "This
 * guest may touch the applications it created" does not: that binding is
 * `{role: sandbox, selector: {owner: <userId>}}`, a predicate over rows that do
 * not exist yet when the guest is created. An IdP that could hold it would be a
 * synchronised replica of Flui's database.
 *
 * So the two vocabularies are disjoint by construction, and it is the
 * construction — not a precedence rule — that removes the question "which one
 * wins when they disagree":
 *
 *   - a project role claim is a **bare key**. There is no field in it that
 *     could carry a selector, a cluster or a section, so every binding this
 *     function returns is `global` with a `null` selector. It cannot express a
 *     delegation even if somebody wanted it to;
 *   - the allowlist is `assignable: true`, which is exactly the four rungs of
 *     the ladder. `sandbox` and `showcase_viewer` — the two roles whose whole
 *     meaning is a selector — are `assignable: false` and can therefore never
 *     arrive from the provider. Decision 102 says "four roles land in Zitadel,
 *     not six"; this is the line that enforces it rather than documenting it;
 *   - both sources are additive-only. Neither can subtract, so folding them is
 *     a union and a union has no precedence.
 *
 * ── Why this is not the floor deny-by-default removed ─────────────────────
 *
 * The old floor came from `pickHighestRole`, which returns `user` when the
 * claim names nothing — every authenticated person got it. This is the
 * opposite: a role has to be *granted* in the provider, on the Flui project,
 * for a binding to appear. No claim, no binding, no permissions. The legacy
 * `admin` / `user` / `readonly` triple is deliberately NOT in the allowlist —
 * those three carry `IdentityRole` and are read by the strategy; reading them
 * here as well would resurrect the floor by the back door.
 *
 * ── And when there is no provider at all ──────────────────────────────────
 *
 * `AUTH_MODE=local` does not install one. Both local strategies populate
 * `roles: {}`, so this returns `[]` and an installation without an IdP behaves
 * exactly as it did before this source existed.
 */
const IDP_SOURCED_ROLES: ReadonlySet<string> = new Set<string>(
  ASSIGNABLE_ROLE_KEYS,
);

/** One entry of the vocabulary Flui provisions on the provider's project. */
export interface IdpProjectRole {
  key: string;
  displayName: string;
}

/**
 * The role keys Flui provisions on the provider's project, so an operator can
 * grant them there. Derived from the ladder rather than listed again: a rung
 * added to the model has to appear in the provider without anybody remembering
 * to copy it, and a rung that is not assignable must never appear at all.
 */
export const IDP_COARSE_ROLES: ReadonlyArray<IdpProjectRole> =
  ASSIGNABLE_ROLE_KEYS.map((key: IamRole) => ({
    key,
    displayName: `Flui — ${BUILTIN_ROLES[key].name}`,
  }));

/**
 * The other half of the vocabulary: one project role per MCP scope, so an agent
 * identity can be granted its ceiling in the provider instead of in a Flui row.
 *
 * Derived from `GRANTABLE_SCOPES`, and that is the whole point of this
 * constant. The list it replaces was six entries hand-copied from a catalogue
 * that has thirteen, so `mcp:iam:read`, `mcp:mail:read`, `mcp:backup:read`,
 * `mcp:backup:write`, `mcp:migration:read`, `mcp:migration:write` and
 * `mcp:migration:destructive` were scopes the reader understood and the
 * provider had no way to express. A credential could not be given them there at
 * all, and nothing said so. `idp-role-source.spec.ts` pins the two together.
 *
 * The display name is derived too, for the same reason: a label written by hand
 * is a label that goes stale on the day a scope is renamed.
 */
export const IDP_AGENT_SCOPE_ROLES: ReadonlyArray<IdpProjectRole> =
  GRANTABLE_SCOPES.map((scope) => ({
    key: scope,
    displayName: `MCP — ${scope.slice(MCP_SCOPE_PREFIX.length).replaceAll(':', ' ')}`,
  }));

/**
 * Everything Flui creates on the provider's project, in one list, because the
 * bootstrap wants one loop and the disjointness test wants one set.
 */
export const IDP_PROJECT_ROLES: ReadonlyArray<IdpProjectRole> = [
  ...IDP_COARSE_ROLES,
  ...IDP_AGENT_SCOPE_ROLES,
];

/**
 * The bindings a principal carries by virtue of the provider's project roles.
 *
 * Global scope and a null selector are not a default here, they are the only
 * thing expressible: see the note above.
 */
export function idpRoleBindings(
  roles: Record<string, unknown> | undefined | null,
): IamBinding[] {
  if (!roles) return [];
  const out: IamBinding[] = [];
  for (const key of Object.keys(roles)) {
    if (!IDP_SOURCED_ROLES.has(key)) continue;
    out.push({
      role: key,
      scopeType: 'global',
      scopeRef: null,
      selector: null,
    });
  }
  return out;
}

/**
 * True when a claimed key belongs to the provider's *agent* vocabulary rather
 * than its role vocabulary. Exported for the disjointness test, which asserts
 * that no key can be read as both.
 */
export function isAgentScopeKey(key: string): boolean {
  return key.startsWith(MCP_SCOPE_PREFIX);
}
