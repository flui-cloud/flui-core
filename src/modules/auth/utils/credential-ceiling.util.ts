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

/** A principal as far as the application ceiling is concerned. */
export interface AppScopedCredential {
  applicationIds?: string[];
  projectIds?: string[];
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
 * Whether the ceiling this credential declares arrived from the identity
 * provider's project roles rather than from a key's own scope list.
 *
 * The ceiling itself stays blind to the source, and must: a credential that
 * declares a ceiling is worth that ceiling wherever it is presented (decision
 * 74), and a rule that asked where the scopes came from would be two rules.
 * This asks only so the *refusal* can be legible, which is a different job.
 */
export function ceilingCameFromIdpRoles(
  credential: ScopedCredential | undefined,
): boolean {
  return Object.keys(credential?.roles ?? {}).some((k) =>
    k.startsWith(MCP_SCOPE_PREFIX),
  );
}

/**
 * The refusal body, written once because it is raised from two guards.
 *
 * Worded differently from the authorization refusal on purpose: "your
 * credential was never granted this" is fixed by re-issuing the key, while "you
 * are not allowed on this resource" is fixed by IAM. An agent told the wrong
 * one of those two retries forever.
 *
 * The second sentence exists because of a surprise that was measured rather
 * than imagined (decision 112): an `mcp:*` project role granted to a *person*
 * in the identity provider — by somebody meaning "this is for her agent" — caps
 * that person's browser session too, and correctly so. The enforcement is
 * right; what was missing was any way to find out why the dashboard had gone
 * read-only. Naming the source turns a bewildering 403 into an instruction, and
 * costs the boundary nothing: it changes no decision, only what the refusal
 * says it decided.
 */
export function ceilingRefusal(
  required: string,
  credential?: ScopedCredential,
): {
  statusCode: number;
  code: string;
  message: string;
} {
  const fromIdp = ceilingCameFromIdpRoles(credential);
  return {
    statusCode: 403,
    code: CREDENTIAL_CEILING_CODE,
    message:
      `This credential's scopes do not carry the permission this call needs: ${required}` +
      (fromIdp
        ? '. They came from `mcp:*` roles on this account in the identity ' +
          'provider, and they cap every session it opens — a browser session ' +
          'included. Agent scopes belong on a machine account, not on a person.'
        : ''),
  };
}

/** How a human login carries the provider's project roles. */
const PROJECT_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';

/** How a token asked for them by scope carries them: one claim per project. */
const PROJECT_SCOPED_ROLES_CLAIM = /^urn:zitadel:iam:org:project:[^:]+:roles$/;

/**
 * The provider's project roles, from every claim they can arrive in.
 *
 * There are two, and reading only the first was a silent widening — the one
 * failure mode a ceiling cannot afford. A browser login carries
 * `urn:zitadel:iam:org:project:roles`, asserted by the project's own setting. A
 * token obtained by `client_credentials` — which is what an agent identity
 * presents — carries nothing at all unless it *asks* for
 * `urn:zitadel:iam:org:projects:roles`, and when it does the provider answers
 * under `urn:zitadel:iam:org:project:<projectId>:roles`, a different key.
 *
 * Measured against the real provider, not remembered: an agent identity minted
 * for `mcp:app:read` presented a token carrying exactly that role — under the
 * project-scoped name — and Flui, reading only the first claim, saw an empty
 * `roles` and therefore **no ceiling at all**. The scopes the identity was
 * created with would have been ignored, and it would have arrived with the full
 * weight of whatever grants it was given rather than the narrow slice somebody
 * chose. Everything downstream is unchanged: the union is still `roles`, still
 * read by `mcpScopesOf` and `idpRoleBindings`, and a claim nobody sends leaves
 * the merge empty exactly as before.
 */
export function projectRolesOf(
  payload: Record<string, unknown> | undefined,
): Record<string, Record<string, string>> {
  const merged: Record<string, Record<string, string>> = {};
  for (const [claim, value] of Object.entries(payload ?? {})) {
    const isRoles =
      claim === PROJECT_ROLES_CLAIM || PROJECT_SCOPED_ROLES_CLAIM.test(claim);
    if (!isRoles || !value || typeof value !== 'object') continue;
    Object.assign(merged, value as Record<string, Record<string, string>>);
  }
  return merged;
}

/**
 * Does this credential still carry its principal's administrator reach?
 *
 * Every WebSocket gateway opened with `if (user.isAdmin) return true`, and that
 * line was the whole of decision 119: an agent key minted by an administrator
 * for `mcp:app:read` arrives on a socket carrying `isAdmin: true`, because a key
 * is issued *as* its principal. On the HTTP path two guards catch that. On a
 * socket nothing did — `credentialCeiling` had exactly two callers and both were
 * HTTP guards — so a read-only key inherited its owner's entire weight on paths
 * no guard watched.
 *
 * The rule is one sentence: **a credential that declares a ceiling is not the
 * whole person, so it does not inherit the person's admin bypass.** It is a
 * narrowing and only ever a narrowing — a session declares no ceiling, the CLI
 * key is unscoped, and neither is touched.
 *
 * Measured before applying it, because a ceiling that switches off a working
 * feature is the error decision 78 exists to remember: **no MCP tool and no
 * in-product assistant uses a socket at all** — the tools were converted to
 * call the API over HTTP — and every subscriber to these gateways is the
 * dashboard, i.e. a browser session. So there is no legitimate agent path this
 * takes away; there is only the escalation one.
 */
export function carriesAdminReach(
  credential: (ScopedCredential & { isAdmin?: boolean }) | undefined,
): boolean {
  if (!credential?.isAdmin) return false;
  return credentialCeiling(credential) === null;
}

/**
 * True when a ceiling is declared and does not carry `permission`.
 *
 * Asked *before* the IAM check, like the two HTTP guards and the terminal do: a
 * ceiling only ever takes away, so asking it first costs a query and answers
 * with the credential's own scopes instead of leaking whether the resource
 * exists.
 */
export function ceilingWithholds(
  credential: ScopedCredential | undefined,
  permission: string,
): boolean {
  const ceiling = credentialCeiling(credential);
  return ceiling !== null && !ceiling.has(permission);
}

/** Error code on a refusal from the application ceiling, distinct from {@link CREDENTIAL_CEILING_CODE}. */
export const APPLICATION_CEILING_CODE = 'CREDENTIAL_APPLICATION_CEILING';

/**
 * True when a credential names specific applications and `applicationId` is
 * not one of them.
 *
 * `undefined`/`null` means unrestricted — the same convention as the scope
 * ceiling: nothing declared narrows nothing. A key minted before this ceiling
 * existed, or minted with no application list, is unaffected.
 */
export function applicationCeilingWithholds(
  credential: AppScopedCredential | undefined,
  applicationId: string,
): boolean {
  const ids = credential?.applicationIds;
  if (!ids?.length) return false;
  return !ids.includes(applicationId);
}

/**
 * The combined form: true unless `applicationId` clears either declared
 * list. `applicationIds` and `projectIds` are alternatives, not requirements
 * that both hold — a key scoped to project P also reaching app A outside P
 * (named individually) must keep reaching A even after A leaves P, which is
 * exactly what a union and not an intersection gives it. Neither list
 * declared reads as unrestricted, same as {@link applicationCeilingWithholds}.
 *
 * Takes `applicationProjectId` as a parameter rather than loading it itself:
 * the caller already has the row (or is about to), and the one thing this
 * check cannot do is decide on its own whether to hit the database — that
 * choice belongs to {@link AppAccessGuard}, which only pays for the load when
 * a credential actually declares a project ceiling.
 */
export function applicationAccessWithheld(
  credential: AppScopedCredential | undefined,
  applicationId: string,
  applicationProjectId: string | null,
): boolean {
  const appIds = credential?.applicationIds;
  const projectIds = credential?.projectIds;
  const hasAppCeiling = !!appIds?.length;
  const hasProjectCeiling = !!projectIds?.length;
  if (!hasAppCeiling && !hasProjectCeiling) return false;
  const allowedByApp = hasAppCeiling && appIds!.includes(applicationId);
  const allowedByProject =
    hasProjectCeiling &&
    !!applicationProjectId &&
    projectIds!.includes(applicationProjectId);
  return !allowedByApp && !allowedByProject;
}

/**
 * The refusal body for the application ceiling, worded so the two ceilings
 * cannot be mistaken for one another: a scope refusal is fixed by re-issuing
 * the key with a wider grant, this one is fixed by extending the SAME key's
 * application list — re-issuing would hand the agent a new credential to
 * reconnect with for no reason, when the fix is one field on the row it
 * already holds. Names exactly where that happens so an agent relays an
 * instruction instead of retrying or inventing a workaround.
 */
export function applicationCeilingRefusal(applicationName: string): {
  statusCode: number;
  code: string;
  message: string;
} {
  return {
    statusCode: 403,
    code: APPLICATION_CEILING_CODE,
    message:
      `This credential's access does not include "${applicationName}". ` +
      'It is limited to specific applications on purpose — ask the person who ' +
      "connected you to extend this key's applications in Settings → Agent " +
      'keys. Re-issuing a new key is not necessary; the same key can be widened.',
  };
}
