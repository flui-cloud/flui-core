import {
  IAM_PERMISSION,
  IamPermission,
} from '../../iam/constants/iam-permissions';
import { MCP_SCOPE, McpScope } from '../../mcp/constants/mcp-scopes';

/**
 * What a scope costs to hand out, and what it is worth once held.
 *
 * These are two different questions and this file used to answer only the
 * first. `requires` is the ceiling on *minting*: a key is issued by somebody
 * and must never be worth more than they are, so for every scope the issuer has
 * to hold the permission named there — checked against the same policy engine
 * that guards the equivalent screen. A request for more is refused whole, never
 * trimmed down to what happens to be allowed, because a credential that quietly
 * comes back smaller than asked for is a credential nobody can reason about.
 *
 * `allows` is the ceiling on *use*: the permissions a credential carrying that
 * scope may exercise on the HTTP path. Reading `requires` backwards to answer
 * that question was the error decision 77 names — "what you must hold to confer
 * this" and "what this lets you do" only coincide by accident. The inversion
 * projected all twelve scopes onto five permissions and lost `app:create`,
 * `app:deploy` and `scale:execute` entirely, which are exactly the verbs the
 * IAM model uses to govern deployment.
 *
 * Two rules keep `allows` honest:
 *   - a *read* scope never names a permission whose verb is a write. IAM's
 *     vocabulary is coarser than this catalogue — there is no `migration:read`,
 *     only `migration:execute` — and where no read-level permission exists the
 *     honest answer is to name none rather than to lend out the write;
 *   - each scope names only its own authority. A key's ceiling is the union
 *     over its scopes, so `apps:destroy` gets `app:delete` from
 *     `mcp:app:destructive` without `mcp:app:write` having to claim it.
 *
 * It stays a *ceiling*, never a grant: it can only take away. A permission
 * inside it still has to survive the IAM check that was already there.
 *
 * Where a scope has no permission of its own, `requires` is pinned to the
 * permission that governs the section the same data is shown in — mail and
 * backups are `cluster:manage` for that reason, not because they are cluster
 * work. That pinning is deliberately *not* copied into `allows`: needing
 * `cluster:manage` to hand out "read the mail log" must not mean the resulting
 * key can manage a cluster.
 */
export interface ScopeAuthority {
  /** The permission the issuer must already hold to confer this scope. */
  requires: IamPermission;
  /** The permissions a credential carrying this scope may exercise. */
  allows: IamPermission[];
}

export const SCOPE_AUTHORITY: Record<McpScope, ScopeAuthority> = {
  [MCP_SCOPE.CATALOG_READ]: {
    requires: IAM_PERMISSION.APP_READ,
    allows: [IAM_PERMISSION.APP_READ],
  },
  // The widest read in the catalogue: the group summaries promise the clusters,
  // repositories, templates, gateway routes and DNS status behind an
  // application, and those routes are read-gated on `cluster:read`.
  [MCP_SCOPE.APP_READ]: {
    requires: IAM_PERMISSION.APP_READ,
    allows: [IAM_PERMISSION.APP_READ, IAM_PERMISSION.CLUSTER_READ],
  },
  [MCP_SCOPE.OBS_READ]: {
    requires: IAM_PERMISSION.APP_READ,
    allows: [IAM_PERMISSION.APP_READ],
  },
  [MCP_SCOPE.BACKUP_READ]: {
    requires: IAM_PERMISSION.CLUSTER_MANAGE,
    allows: [IAM_PERMISSION.CLUSTER_READ],
  },
  // No `migration:read` exists in IAM, and lending `migration:execute` to a
  // read scope would make "see migrations" and "run migrations" the same
  // credential. It reads the applications and clusters a migration names.
  [MCP_SCOPE.MIGRATION_READ]: {
    requires: IAM_PERMISSION.MIGRATION_EXECUTE,
    allows: [IAM_PERMISSION.APP_READ, IAM_PERMISSION.CLUSTER_READ],
  },
  [MCP_SCOPE.MAIL_READ]: {
    requires: IAM_PERMISSION.CLUSTER_MANAGE,
    allows: [IAM_PERMISSION.CLUSTER_READ],
  },
  /**
   * Read the grant graph, and what a change to it would take away.
   *
   * `requires` is the *write* permission on purpose: handing an agent the
   * ability to read who can reach what is a decision only somebody who
   * administers access should be able to make. `allows` is the read half and
   * only the read half — which is the whole reason `iam:read-access` exists as
   * a permission of its own. Naming `iam:assign-role` here instead would have
   * let a key labelled "look" confer roles over plain HTTP, which is the rule
   * at the top of this file broken in one line.
   */
  [MCP_SCOPE.IAM_READ]: {
    requires: IAM_PERMISSION.IAM_ASSIGN_ROLE,
    allows: [IAM_PERMISSION.IAM_READ_ACCESS],
  },
  /**
   * Confer and revoke a delegation — the one scope here that changes who else
   * can reach the instance.
   *
   * Both columns name `iam:assign-role`, and the coincidence is the guarantee
   * rather than a shortcut. `requires` says an issuer must already administer
   * access to hand this on, so a key is never worth more than whoever minted
   * it; `allows` says the resulting key may exercise exactly that permission
   * and nothing else. Read together: **an agent can never confer a permission
   * its owner does not hold**, because the mint refuses the scope and, even if
   * the scope were held, `ApiKeyStrategy` re-reads the owner's identity on
   * every call and the route's own `iam:assign-role` check still runs. Nothing
   * had to be added for that; it is how minting already works.
   *
   * It names only the write. Reading the grant graph — the list, the revocation
   * preview — is `mcp:iam:read`, and the `access:change` group carries both, so
   * an agent that may confer can also see what it is about to take away
   * (requirement 42). Naming `iam:read-access` here too would make the read
   * scope pointless as a switch of its own.
   *
   * `iam:manage-users` is deliberately not here: creating and deleting people
   * is a different power from deciding what an existing person may reach.
   */
  [MCP_SCOPE.IAM_WRITE]: {
    requires: IAM_PERMISSION.IAM_ASSIGN_ROLE,
    allows: [IAM_PERMISSION.IAM_ASSIGN_ROLE],
  },
  [MCP_SCOPE.SPEC_VALIDATE]: {
    requires: IAM_PERMISSION.APP_READ,
    allows: [IAM_PERMISSION.APP_READ],
  },
  /**
   * The four verbs "Deploy and operate applications" promises in one sentence.
   *
   * `app:write` alone would be a switch that deploys nothing: creating an
   * application from a manifest asks for `app:create`, a rollback asks for
   * `app:deploy`, and scaling has `scale:execute` of its own in the role
   * definitions. Leaving them out is the failure mode decision 77 predicts —
   * the ceiling would refuse the exact calls the group exists to permit.
   */
  [MCP_SCOPE.APP_WRITE]: {
    requires: IAM_PERMISSION.APP_WRITE,
    allows: [
      IAM_PERMISSION.APP_READ,
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.SCALE_EXECUTE,
    ],
  },
  [MCP_SCOPE.BACKUP_WRITE]: {
    requires: IAM_PERMISSION.CLUSTER_MANAGE,
    allows: [IAM_PERMISSION.CLUSTER_READ, IAM_PERMISSION.CLUSTER_MANAGE],
  },
  [MCP_SCOPE.MIGRATION_WRITE]: {
    requires: IAM_PERMISSION.MIGRATION_EXECUTE,
    allows: [
      IAM_PERMISSION.APP_READ,
      IAM_PERMISSION.CLUSTER_READ,
      IAM_PERMISSION.MIGRATION_EXECUTE,
    ],
  },
  // Only the delete. Everything else a destructive key does it does because it
  // also carries `mcp:app:write` — the group names both, and the union is what
  // applies.
  [MCP_SCOPE.APP_DESTRUCTIVE]: {
    requires: IAM_PERMISSION.APP_DELETE,
    allows: [IAM_PERMISSION.APP_DELETE],
  },
  /**
   * Aborting a migration, and nothing about the cluster it moved away from.
   *
   * The group summary says "destroying the source it moved away from", and
   * `cluster:destroy` is a permission of its own precisely so that destroying a
   * cluster is never a side effect of some other grant. An agent
   * that must tear a cluster down needs that decision made explicitly, not
   * inherited from a migration scope.
   */
  [MCP_SCOPE.MIGRATION_DESTRUCTIVE]: {
    requires: IAM_PERMISSION.MIGRATION_EXECUTE,
    allows: [IAM_PERMISSION.MIGRATION_EXECUTE],
  },
};

/**
 * The minting half of {@link SCOPE_AUTHORITY}, derived rather than written
 * again: one table, read two ways, so the two readings cannot drift.
 */
export const SCOPE_REQUIRES_PERMISSION: Record<McpScope, IamPermission> =
  Object.fromEntries(
    Object.entries(SCOPE_AUTHORITY).map(([scope, a]) => [scope, a.requires]),
  ) as Record<McpScope, IamPermission>;

export const GRANTABLE_SCOPES: McpScope[] = Object.keys(
  SCOPE_AUTHORITY,
) as McpScope[];

export function isGrantableScope(scope: string): scope is McpScope {
  return scope in SCOPE_AUTHORITY;
}

/**
 * The canonical order above, applied to a set of scopes.
 *
 * A key asked for by group is assembled from several lists, so without this the
 * stored column would carry the order the request happened to arrive in — and
 * two identical grants would read as two different credentials.
 */
export function orderScopes(scopes: string[]): McpScope[] {
  return GRANTABLE_SCOPES.filter((s) => scopes.includes(s));
}
