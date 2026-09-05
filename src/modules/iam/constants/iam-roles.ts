import { IdentityRole } from '../../auth/entities/user.entity';
import { PrincipalAccess } from '../interfaces/iam.types';
import { IAM_PERMISSION, IamPermission } from './iam-permissions';

/**
 * Built-in roles — one ladder of four, plus two the platform assigns to itself.
 * "Few roles, rich targets": *which* resources is a target (selector), not a
 * role. Roles are data (this is the seed); custom-role authoring is deferred.
 *
 * The ladder is cumulative and that is the load-bearing property, not the names:
 *
 *   viewer ⊆ operator ⊆ maintainer ⊆ owner
 *
 * `iam-roles.spec.ts` asserts it directly. It is asserted rather than assumed
 * because the version of this file that preceded it had drifted out of it
 * without anybody noticing: `viewer` carried `cluster:read` and `editor` — the
 * step above it — did not, so the lower rung saw a section the higher one could
 * not open. That was not a typo in one list, it was an invariant nobody had
 * written down. Written down, it cannot come back quietly.
 *
 * The lists stay spelled out instead of being composed from the rung below.
 * Composition would make the invariant true by construction and hide the second
 * property the model needs: a permission added to the catalogue and to no role
 * must turn a test red, so that somebody *decides* where it belongs instead of
 * inheriting it (see the note on `owner`).
 */
export const IAM_ROLE = {
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  MAINTAINER: 'maintainer',
  OWNER: 'owner',
  SANDBOX: 'sandbox',
  SHOWCASE_VIEWER: 'showcase_viewer',
} as const;

export type IamRole = (typeof IAM_ROLE)[keyof typeof IAM_ROLE];

export interface IamRoleDef {
  key: IamRole;
  name: string;
  description: string;
  permissions: IamPermission[];
  /**
   * May a person name this role in a grant?
   *
   * False does not mean "nobody holds it": `sandbox` and `showcase_viewer` are
   * written by the platform itself (the tenancy service creates them row by
   * row), and refusing them here is a description of what already happens — the
   * grant DTO has always rejected both. Saying it once, here, is also what keeps
   * them out of every screen, list and picker that describes roles to a person:
   * `listRolesFor` serves only the assignable ones, because a tenancy the
   * platform writes is not a tier of access anybody chooses.
   */
  assignable: boolean;
  /**
   * A permission the *grantor* must hold, at GLOBAL scope, to confer or revoke
   * this role — on top of the `iam:assign-role` the route already asks for.
   *
   * Undefined for the three roles below `owner`: whoever may manage access at
   * all may hand them out, which is today's behaviour and is not widened here.
   * Global scope, not "anywhere", for the reason the management sections use
   * it: a grant that only reaches one cluster must not decide who runs the
   * whole installation.
   */
  conferredBy?: IamPermission;
}

export const BUILTIN_ROLES: Record<IamRole, IamRoleDef> = {
  /**
   * `cluster:read` is here on purpose and is the one place the model chooses
   * visibility over minimalism: it is the gate of the Clusters section, so
   * without it a viewer reads the applications and cannot open the page that
   * says what they run on.
   */
  [IAM_ROLE.VIEWER]: {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only across everything in scope.',
    permissions: [IAM_PERMISSION.APP_READ, IAM_PERMISSION.CLUSTER_READ],
    assignable: true,
  },
  /**
   * The complete lifecycle of the applications a grant reaches — including
   * deleting them.
   *
   * `app:delete` is here rather than one rung up because the rung that withheld
   * it could not be defended: the anonymous guest of the public demo deletes its
   * own applications and the trusted colleague did not. What protects an
   * application from a careless removal is the *selector* — you delete only what
   * your grant reaches — plus the preview that now says how much data goes with
   * it, not the amputation of the verb from a whole role. No fifth rung
   * "deploys but does not delete": every rung has to earn a real person.
   */
  [IAM_ROLE.OPERATOR]: {
    key: 'operator',
    name: 'Operator',
    description:
      'View, deploy, operate and remove the apps in scope. Cannot manage access or infrastructure.',
    permissions: [
      IAM_PERMISSION.APP_READ,
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.APP_DELETE,
      IAM_PERMISSION.SCALE_EXECUTE,
      IAM_PERMISSION.MIGRATION_EXECUTE,
      IAM_PERMISSION.CLUSTER_READ,
    ],
    assignable: true,
  },
  /**
   * Whoever keeps the installation running: the machines, who may reach what,
   * the shared GitHub credentials, the showcase and the public demonstration.
   *
   * Wider than the `manager` it replaces by three permissions, and the price is
   * stated: more people can rotate the instance's GitHub App and decide what a
   * guest of the demo sees. It stops exactly below the two irreversible acts.
   */
  [IAM_ROLE.MAINTAINER]: {
    key: 'maintainer',
    name: 'Maintainer',
    description:
      'Operator + the installation itself: clusters, access, integrations, the showcase and the demo.',
    permissions: [
      IAM_PERMISSION.APP_READ,
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.APP_DELETE,
      IAM_PERMISSION.SCALE_EXECUTE,
      IAM_PERMISSION.MIGRATION_EXECUTE,
      IAM_PERMISSION.CLUSTER_READ,
      IAM_PERMISSION.CLUSTER_MANAGE,
      IAM_PERMISSION.IAM_ASSIGN_ROLE,
      IAM_PERMISSION.IAM_READ_ACCESS,
      IAM_PERMISSION.INTEGRATION_MANAGE,
      IAM_PERMISSION.SHOWCASE_PUBLISH,
      IAM_PERMISSION.SANDBOX_OPERATE,
      IAM_PERMISSION.PLATFORM_UPDATE,
    ],
    assignable: true,
  },
  /**
   * The role the platform-admin boolean used to be.
   *
   * It exists because a binding names a *role*, never a permission: while
   * `isAdmin` was the only way to say "everything", nobody could be given
   * everything through IAM, and taking the boolean away would have left every
   * live installation with administrators holding nothing. The backfill
   * migration writes one of these for each of them.
   *
   * The permission list is deliberately written out rather than computed from
   * the catalog: a role that quietly absorbs whatever permission is added next
   * is the boolean again under another name. `iam-roles.spec.ts` asserts that it
   * covers the whole catalog except `section:view` — so adding a permission
   * turns that test red and someone decides, instead of inheriting.
   *
   * `section:view` is absent because it is a *level*, not a power: it opens a
   * section read-only, and this role already opens every section at full.
   */
  [IAM_ROLE.OWNER]: {
    key: 'owner',
    name: 'Owner',
    description:
      'Everything, everywhere, including who else may run this installation.',
    permissions: [
      IAM_PERMISSION.APP_READ,
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.APP_DELETE,
      IAM_PERMISSION.SCALE_EXECUTE,
      IAM_PERMISSION.MIGRATION_EXECUTE,
      IAM_PERMISSION.CLUSTER_READ,
      IAM_PERMISSION.CLUSTER_MANAGE,
      IAM_PERMISSION.CLUSTER_DESTROY,
      IAM_PERMISSION.IAM_ASSIGN_ROLE,
      IAM_PERMISSION.IAM_READ_ACCESS,
      IAM_PERMISSION.IAM_MANAGE_USERS,
      IAM_PERMISSION.INTEGRATION_MANAGE,
      IAM_PERMISSION.SHOWCASE_PUBLISH,
      IAM_PERMISSION.SANDBOX_OPERATE,
      IAM_PERMISSION.PLATFORM_UPDATE,
    ],
    assignable: true,
    // Only an owner makes an owner. A `maintainer` holds `iam:assign-role` and
    // can already create grants — without this line they would hand themselves
    // the top role through the access screen, which is the same privilege ladder
    // section 8 closed on `PATCH /auth/users/:id/role`, entered by another door.
    conferredBy: IAM_PERMISSION.IAM_MANAGE_USERS,
  },
  /**
   * A public guest on the shared demo instance. Deliberately NOT "operator minus
   * something": the permissions here are only the inner half of the fence — the
   * outer half is SandboxFenceGuard, which denies every route this role is not
   * meant to reach. Permissions alone cannot express the boundary, because
   * several of them are required by no route at all.
   */
  [IAM_ROLE.SANDBOX]: {
    key: 'sandbox',
    name: 'Sandbox guest',
    description:
      'A guest of the public demo. Owns its own applications for the life of its tenancy and reaches nothing else.',
    permissions: [
      IAM_PERMISSION.APP_READ,
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.APP_DEPLOY,
      // The one destructive verb a guest holds, and it only ever reaches their
      // own application: AppAccessGuard asks for `app:delete` on that resource,
      // and the fence names the route. It is here because the tenancy is a
      // fixed quota — removing what you no longer need is how you make room for
      // the next thing, and without it the trial got smaller the more you used
      // it. `sandbox-areas.ts` has promised "yours to deploy, scale, read and
      // delete" all along; this is the line that makes the sentence true.
      IAM_PERMISSION.APP_DELETE,
      // The other half of that same sentence. Replicas, stop, start and restart
      // stopped deriving `app:write` from their verb and now ask for
      // `scale:execute` by name, so without this line "yours to scale" answers
      // 403 to every guest. How *many* copies a guest may run is not decided
      // here and must not be: the tenancy's ResourceQuota and LimitRange decide
      // it, and Kubernetes refuses the excess.
      IAM_PERMISSION.SCALE_EXECUTE,
      // Enters the management sections at their read-only level, so the menu
      // names them and their screens open. It grants no write — the section
      // guard refuses every unsafe verb behind it — and it widens nothing on
      // its own: the fence still decides which routes a guest may call at all,
      // and the sections whose real data belongs to other people are answered
      // from the example world instead of from the instance.
      IAM_PERMISSION.SECTION_VIEW,
    ],
    // Written by the tenancy service when a guest arrives, never by a person.
    assignable: false,
  },
  /**
   * Read one specific set of applications and learn nothing else.
   *
   * Deliberately not `viewer`, which would have been the natural fit for
   * "read-only over a selector": `viewer` also carries `cluster:read`, and a
   * permission check made without a resource is satisfied by any scoped grant
   * that holds the permission at all. Granting this to an anonymous visitor
   * would have widened the inner ring and left the route fence as the only thing
   * still saying no. One permission, so there is nothing to widen.
   */
  [IAM_ROLE.SHOWCASE_VIEWER]: {
    key: 'showcase_viewer',
    name: 'Showcase viewer',
    description:
      'Read-only over the applications the platform’s operators put on display, and nothing else.',
    permissions: [IAM_PERMISSION.APP_READ],
    // Comes with a tenancy, like the role above it.
    assignable: false,
  },
};

/**
 * The ladder, in order, and the only place its order is written.
 *
 * The invariant test walks it pairwise; anything that needs "the rung above" —
 * a gateway `minRole`, a screen that explains the model — reads it from here
 * rather than re-listing the names.
 */
export const ROLE_LADDER: IamRole[] = [
  IAM_ROLE.VIEWER,
  IAM_ROLE.OPERATOR,
  IAM_ROLE.MAINTAINER,
  IAM_ROLE.OWNER,
];

/**
 * The IdP-derived coarse role maps 1:1 to a built-in role.
 *
 * Nothing reads this today — deny-by-default removed the implicit floor it used
 * to describe. It is kept correct rather than left to rot because what it says
 * has to stay true if anything ever reads it again: the IdP's `admin` is the
 * platform administrator, and mapping it anywhere below `owner` would understate
 * it by exactly the role that replaced the boolean.
 */
export const ROLE_FROM_IDENTITY: Record<IdentityRole, IamRole> = {
  [IdentityRole.ADMIN]: IAM_ROLE.OWNER,
  [IdentityRole.USER]: IAM_ROLE.OPERATOR,
  [IdentityRole.READONLY]: IAM_ROLE.VIEWER,
};

export function permissionsForRole(role: string): IamPermission[] {
  return BUILTIN_ROLES[role as IamRole]?.permissions ?? [];
}

/** The roles a person may name in a grant — the wire's enum, derived from the defs. */
export const ASSIGNABLE_ROLE_KEYS: IamRole[] = Object.values(BUILTIN_ROLES)
  .filter((r) => r.assignable)
  .map((r) => r.key);

/**
 * May this principal create *or* remove a binding carrying this role?
 *
 * Removal matters as much as conferral: a `maintainer` who could delete an
 * owner's binding would be able to strip the installation of its administrators
 * one row at a time — the same ladder as promotion, descended instead of climbed.
 *
 * The legacy platform-admin boolean still answers yes, and must: the gates now
 * name permissions, but the boolean still resolves to the whole catalog, and it
 * is what the installation credentials — which are not rows in `users` — hold.
 */
export function mayAdministerRole(
  access: PrincipalAccess,
  role: string,
): boolean {
  if (access.isAdmin) return true;
  const required = BUILTIN_ROLES[role as IamRole]?.conferredBy;
  return !required || access.globalPermissions.has(required);
}

/** May this principal hand this role out? Roles the platform assigns are never conferrable. */
export function mayConferRole(access: PrincipalAccess, role: string): boolean {
  return (
    (BUILTIN_ROLES[role as IamRole]?.assignable ?? false) &&
    mayAdministerRole(access, role)
  );
}
