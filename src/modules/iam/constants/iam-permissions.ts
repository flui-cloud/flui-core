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
   * calling them "destroy" would be a name that lies.
   */
  CLUSTER_DESTROY: 'cluster:destroy',
  BILLING_READ: 'billing:read',
  IAM_ASSIGN_ROLE: 'iam:assign-role',
  /**
   * Read who can reach what — the grant graph, and what a change to it would
   * take away — without being able to change any of it.
   *
   * Split out of `iam:assign-role` rather than reusing it, and the reason is
   * the credential ceiling: `SCOPE_AUTHORITY` forbids a read scope from naming
   * a permission whose verb is a write, so with `iam:assign-role` as the only
   * key to this data an agent credential could either not read it at all or
   * could also confer roles over plain HTTP. It grants nobody anything new —
   * every role that holds `iam:assign-role` holds this too — it only makes a
   * read-only half nameable.
   */
  IAM_READ_ACCESS: 'iam:read-access',
  /**
   * Create and delete platform accounts, recompose someone's password — and
   * confer or revoke the `owner` role itself, which is the only use it has
   * today (see `mayConferRole`).
   *
   * Separate from `iam:assign-role` on purpose: that one is held by `manager`,
   * and reusing it would silently turn "a manager assigns roles" into "a manager
   * creates accounts, resets anyone's password and promotes themselves to the
   * top role".
   */
  IAM_MANAGE_USERS: 'iam:manage-users',
  /**
   * The instance's own GitHub credentials — the App and the PAT that everyone
   * who later connects a repository ends up borrowing.
   *
   * Not `platform:bootstrap`, because it is not an act of installation: the App
   * is re-made when it expires or changes owner. Not `cluster:manage`, because
   * it touches no cluster. A repository *belonging to a person* is a different
   * question and is deliberately not this permission.
   */
  INTEGRATION_MANAGE: 'integration:manage',
  /**
   * Put an application in the showcase, or take it out.
   *
   * An access decision rather than an edit: the `showcase` tag is what
   * SHOWCASE_GRANT selects on, so publishing puts an application in front of
   * every guest on the instance. Deliberately not `app:write` — otherwise
   * anyone who may change an application could also decide who sees it.
   */
  SHOWCASE_PUBLISH: 'showcase:publish',
  /**
   * Read how many guest areas this instance is holding, and expire one.
   *
   * A name of its own rather than `cluster:manage` because these routes have a
   * live CLI caller and describe the *demonstration*, not the machines: one day
   * whoever runs the trial will not be whoever runs the clusters.
   */
  SANDBOX_OPERATE: 'sandbox:operate',
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
