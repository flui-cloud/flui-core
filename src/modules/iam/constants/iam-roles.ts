import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION, IamPermission } from './iam-permissions';

/**
 * Built-in roles — 3 only (Azure-pure: Viewer/Editor/Manager). "Few roles, rich
 * targets": *which* resources is a target (selector), not a role. Roles are data
 * (this is the seed); custom-role authoring is deferred.
 */
export const IAM_ROLE = {
  VIEWER: 'viewer',
  EDITOR: 'editor',
  MANAGER: 'manager',
  SANDBOX: 'sandbox',
  SHOWCASE_VIEWER: 'showcase_viewer',
} as const;

export type IamRole = (typeof IAM_ROLE)[keyof typeof IAM_ROLE];

export interface IamRoleDef {
  key: IamRole;
  name: string;
  description: string;
  permissions: IamPermission[];
}

export const BUILTIN_ROLES: Record<IamRole, IamRoleDef> = {
  [IAM_ROLE.VIEWER]: {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only across everything in scope.',
    permissions: [IAM_PERMISSION.APP_READ, IAM_PERMISSION.CLUSTER_READ],
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
    ],
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
  },
};

/** The IdP-derived coarse role maps 1:1 to a built-in role (implicit global binding). */
export const ROLE_FROM_IDENTITY: Record<IdentityRole, IamRole> = {
  [IdentityRole.ADMIN]: IAM_ROLE.MANAGER,
  [IdentityRole.USER]: IAM_ROLE.EDITOR,
  [IdentityRole.READONLY]: IAM_ROLE.VIEWER,
};

export function permissionsForRole(role: string): IamPermission[] {
  return BUILTIN_ROLES[role as IamRole]?.permissions ?? [];
}
