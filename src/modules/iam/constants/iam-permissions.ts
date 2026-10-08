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
   * Separate from `iam:assign-role` on purpose: that one is held by `maintainer`,
   * and reusing it would silently turn "a maintainer assigns roles" into "a maintainer
   * creates accounts, resets anyone's password and promotes themselves to the
   * top role".
   */
  IAM_MANAGE_USERS: 'iam:manage-users',
  /**
   * The instance's own credentials to the outside world — the GitHub App and
   * PAT that everyone who later connects a repository ends up borrowing, and
   * the model-provider connections every assistant on the installation speaks
   * through.
   *
   * Not `platform:bootstrap`, because it is not an act of installation: the App
   * is re-made when it expires or changes owner. Not `cluster:manage`, because
   * it touches no cluster — and because `mcp:backup:write` carries
   * `cluster:manage`, which would have let a backup agent unplug the model. A
   * credential *belonging to a person* is a different question and is
   * deliberately not this permission: a personal GHCR token and a repository
   * somebody connected are theirs, decided by ownership.
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
  /**
   * Decide which ports the applications on a cluster may reach outside it.
   *
   * Not `cluster:manage`: the rule is what keeps a guest, or anybody's
   * application, from mailing spam or scanning the internet from the
   * installation's addresses, and whoever may resize a cluster should not
   * open that by implication. No agent scope carries it; an agent reads the
   * rule so it stops waiting on a port that will never answer.
   */
  EGRESS_MANAGE: 'egress:manage',
  /**
   * Move this installation to a newer Flui release — the API, the dashboard and
   * the authorization service, together.
   *
   * Its own key rather than `cluster:manage`: it changes no cluster and touches
   * no workload, it replaces the control plane that is answering the request,
   * and it applies database migrations a rollback does not undo. Nothing that
   * manages infrastructure should acquire that by implication.
   */
  PLATFORM_UPDATE: 'platform:update',
  /**
   * Bring the manifests on the master into line with a bootstrap ref that is not
   * a published release — a branch, a commit, a tag nobody announced.
   *
   * `platform:update` moves an installation between releases somebody published
   * and described. A free ref is a different act: it runs whatever that ref
   * holds, with nothing written about it. Kept apart so the role that keeps an
   * installation current does not also run unreleased work by implication.
   */
  PLATFORM_PREVIEW: 'platform:preview',
  /**
   * Reach the data of an application: its logs, its variables' values, a
   * console inside it, a shell on the nodes it runs on, a restore or a copy of
   * its volumes. Required on top of whatever the route already asks for, by
   * marking the route `@DataDoor()`. Held by every role except
   * platform_operator.
   */
  DATA_ACCESS: 'data:access',
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
