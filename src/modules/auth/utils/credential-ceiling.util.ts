import { SCOPE_AUTHORITY } from '../constants/api-key-scopes';

/**
 * The ceiling a credential declares, read off the principal and applied on the
 * HTTP path — not only on MCP.
 *
 * Until now an `mcp:*` scope bound the toolbox and nothing else: the same key
 * used with `curl` was worth exactly as much as the person who minted it. This
 * is the other half. It reads the `allows` column of {@link SCOPE_AUTHORITY},
 * which is the only place that says what a scope permits.
 *
 * It used to invert `requires` instead, and that was wrong for a reason worth
 * keeping written down: the permission an issuer must hold to
 * *confer* a scope is not the permission the scope *carries*. The inversion
 * folded twelve scopes onto five permissions and dropped `app:create`,
 * `app:deploy` and `scale:execute`, so a key minted for "Deploy and operate
 * applications" would have been refused the deploy.
 *
 * It is a *ceiling*, never a grant: it can only take away. A permission inside
 * the ceiling still has to survive the IAM check that was already there.
 */

export const MCP_SCOPE_PREFIX = 'mcp:';

/** A principal as far as the ceiling is concerned: whatever carries scopes. */
export interface ScopedCredential {
  scopes?: string[];
  roles?: Record<string, unknown>;
}

/**
 * The `mcp:*` scopes on a credential, from either place they can arrive.
 *
 * The prefix is the discriminant, and deliberately so. An explicit "this is an
 * agent credential" flag was the alternative and it is the wrong one: the
 * ceiling has to be blind to where the scopes came from, because the next
 * source is the identity provider (project roles named `mcp:*`, which land in
 * `roles` and not in `scopes`) and a flag stored on Flui's own api_keys row
 * could never be set on those. Same rule as `McpScopeResolver`, on purpose.
 *
 * The prefix is also what keeps interactive sessions out of it: an OIDC access
 * token carries `openid profile email` in `scope`, and reading "has scopes" as
 * "is capped" would shut every logged-in person out of the product.
 */
export function mcpScopesOf(
  credential: ScopedCredential | undefined,
): string[] {
  if (!credential) return [];
  const found = new Set<string>();
  for (const scope of credential.scopes ?? []) {
    if (scope.startsWith(MCP_SCOPE_PREFIX)) found.add(scope);
  }
  for (const roleKey of Object.keys(credential.roles ?? {})) {
    if (roleKey.startsWith(MCP_SCOPE_PREFIX)) found.add(roleKey);
  }
  return [...found];
}

/**
 * The permissions a credential is allowed to exercise, or `null` when it
 * declares no ceiling at all.
 *
 * `null` and an empty set are different answers and the difference matters:
 * `null` is the CLI key, the service identities and every interactive session —
 * `scopes: null` on the row means "nothing was declared", which
 * `ApiKeyService.generateApiKey` writes deliberately rather than `[]`. An empty
 * set is a credential that declared scopes Flui does not recognise, and it is
 * refused everywhere, which is the safe reading of "I do not know what this is".
 */
export function credentialCeiling(
  credential: ScopedCredential | undefined,
): Set<string> | null {
  const scopes = mcpScopesOf(credential);
  if (!scopes.length) return null;
  const allowed = new Set<string>();
  for (const scope of scopes) {
    const authority = SCOPE_AUTHORITY[scope as keyof typeof SCOPE_AUTHORITY];
    for (const permission of authority?.allows ?? []) allowed.add(permission);
  }
  return allowed;
}

/** Error code on every ceiling refusal, wherever it is raised. */
export const CREDENTIAL_CEILING_CODE = 'CREDENTIAL_SCOPE_CEILING';

/**
 * The refusal body, written once because it is raised from two guards.
 *
 * Worded differently from the authorization refusal on purpose: "your
 * credential was never granted this" is fixed by re-issuing the key, while "you
 * are not allowed on this resource" is fixed by IAM. An agent told the wrong
 * one of those two retries forever.
 */
export function ceilingRefusal(required: string): {
  statusCode: number;
  code: string;
  message: string;
} {
  return {
    statusCode: 403,
    code: CREDENTIAL_CEILING_CODE,
    message: `This credential's scopes do not carry the permission this call needs: ${required}`,
  };
}
