import { IdentityRole } from '../../auth/entities/user.entity';
import { PrincipalAccess } from '../interfaces/iam.types';
import { IAM_PERMISSION, IamPermission } from './iam-permissions';

/**
 * Built-in roles — the Azure ladder (Viewer/Editor/Manager) plus `owner` above
 * it, and two the platform assigns to itself. "Few roles, rich targets": *which*
 * resources is a target (selector), not a role. Roles are data (this is the
 * seed); custom-role authoring is deferred.
 */
export const IAM_ROLE = {
  VIEWER: 'viewer',
  EDITOR: 'editor',
  MANAGER: 'manager',
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
   * grant DTO has always rejected both. Saying it once, here, is what lets the
   * screen stop offering them.
   */
  assignable: boolean;
  /**
   * A permission the *grantor* must hold, at GLOBAL scope, to confer or revoke
   * this role — on top of the `iam:assign-role` the route already asks for.
   *
   * Undefined for the three ordinary roles: whoever may manage access at all
   * may hand them out, which is today's behaviour and is not widened here.
   * Global scope, not "anywhere", for the reason the management sections use
   * it: a grant that only reaches one cluster must not decide who runs the
   * whole installation.
   */
  conferredBy?: IamPermission;
}

export const BUILTIN_ROLES: Record<IamRole, IamRoleDef> = {
  [IAM_ROLE.VIEWER]: {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only across everything in scope.',
    permissions: [IAM_PERMISSION.APP_READ, IAM_PERMISSION.CLUSTER_READ],
    assignable: true,
  },
  [IAM_ROLE.EDITOR]: {
    key: 'editor',
    name: 'Editor',
    description: 'View, modify, deploy and operate apps. Cannot manage access.',
    permissions: [
      IAM_PERMISSION.APP_READ,
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.SCALE_EXECUTE,
      IAM_PERMISSION.MIGRATION_EXECUTE,
    ],
    assignable: true,
  },
  [IAM_ROLE.MANAGER]: {
    key: 'manager',
    name: 'Manager',
    description: 'Editor + manage access at this scope and below.',
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
      IAM_PERMISSION.BILLING_READ,
      IAM_PERMISSION.IAM_ASSIGN_ROLE,
      IAM_PERMISSION.IAM_MANAGE_USERS,
    ],
    assignable: true,
    // Only an owner makes an owner. A `manager` holds `iam:assign-role` and can
    // already create grants — without this line they would hand themselves the
    // top role through the access screen, which is the same privilege ladder
    // section 8 closed on `PATCH /auth/users/:id/role`, entered by another door.
    conferredBy: IAM_PERMISSION.IAM_MANAGE_USERS,
  },
  /**
   * A public guest on the shared demo instance. Deliberately NOT "editor minus
   * something": the permissions here are only the inner half of the fence — the
   * outer half is SandboxFenceGuard, which denies every route this role is not
   * meant to reach. Permissions alone cannot express the boundary, because five
   * of the eleven are required by no route at all.
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
 * The IdP-derived coarse role maps 1:1 to a built-in role.
 *
 * Nothing reads this today — deny-by-default removed the implicit floor it used
 * to describe. It is corrected rather than left alone because what it said had
 * become false: the IdP's `admin` is the platform administrator, and mapping it
 * to `manager` would have understated it by exactly the role added above.
 */
export const ROLE_FROM_IDENTITY: Record<IdentityRole, IamRole> = {
  [IdentityRole.ADMIN]: IAM_ROLE.OWNER,
  [IdentityRole.USER]: IAM_ROLE.EDITOR,
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
 * Removal matters as much as conferral: a `manager` who could delete an owner's
 * binding would be able to strip the installation of its administrators one row
 * at a time — the same ladder as promotion, descended instead of climbed.
 *
 * The legacy platform-admin boolean still answers yes, and must: until the 58
 * `@Admin()` sites move over, it is what the people who run live installations
 * actually hold.
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
