/**
 * IAM permission catalog — atomic, flat keys (the unit a role bundles and an
 * endpoint requires). Mirrors the MCP scope-catalog style. Extend as needed.
 */
export const IAM_PERMISSION = {
  APP_READ: 'app:read',
  APP_WRITE: 'app:write',
  APP_DEPLOY: 'app:deploy',
  APP_CREATE: 'app:create',
  APP_DELETE: 'app:delete',
  SCALE_EXECUTE: 'scale:execute',
  MIGRATION_EXECUTE: 'migration:execute',
  CLUSTER_READ: 'cluster:read',
  CLUSTER_MANAGE: 'cluster:manage',
  /**
   * Destroy a cluster — `DELETE /infrastructure/clusters/:id` and nothing else.
   * `stop`/`start` deliberately stay with the section: they are reversible and
   * calling them "destroy" would be a name that lies (decision 2, as corrected).
   *
   * Declared here, held by `owner`, and not yet required by any route: the 58
   * `@Admin()` sites are the next section's work, not this one's.
   */
  CLUSTER_DESTROY: 'cluster:destroy',
  BILLING_READ: 'billing:read',
  IAM_ASSIGN_ROLE: 'iam:assign-role',
  /**
   * Create and delete platform accounts, recompose someone's password — and
   * confer or revoke the `owner` role itself, which is the only use it has
   * today (see `mayConferRole`).
   *
   * Separate from `iam:assign-role` on purpose: that one is held by `manager`,
   * and reusing it would silently turn "a manager assigns roles" into "a manager
   * creates accounts, resets anyone's password and promotes themselves to the
   * top role" (decision 3).
   */
  IAM_MANAGE_USERS: 'iam:manage-users',
  // Enter a management section without being able to change anything in it.
  // Not a governing permission: it opens the door at the lowest level the
  // section model has, and SectionAccessGuard refuses every unsafe verb behind
  // it. Held today only by the sandbox guest, whose routes are additionally
  // narrowed by the sandbox fence — see the note on SECTION view gates.
  SECTION_VIEW: 'section:view',
} as const;

export type IamPermission =
  (typeof IAM_PERMISSION)[keyof typeof IAM_PERMISSION];

export const ALL_PERMISSIONS: IamPermission[] = Object.values(IAM_PERMISSION);
