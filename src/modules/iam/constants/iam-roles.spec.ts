import {
  ALL_PERMISSIONS,
  IAM_PERMISSION,
  IamPermission,
} from './iam-permissions';
import {
  ASSIGNABLE_ROLE_KEYS,
  BUILTIN_ROLES,
  IAM_ROLE,
  mayAdministerRole,
  mayConferRole,
} from './iam-roles';
import { PrincipalAccess } from '../interfaces/iam.types';

function access(
  permissions: string[],
  extra: Partial<PrincipalAccess> = {},
): PrincipalAccess {
  return {
    isAdmin: false,
    globalPermissions: new Set(permissions),
    scopedGrants: [],
    isSandbox: false,
    ...extra,
  };
}

const OWNER = BUILTIN_ROLES[IAM_ROLE.OWNER];
const MANAGER = BUILTIN_ROLES[IAM_ROLE.MANAGER];

const MANAGER_ACCESS = access(MANAGER.permissions);
const OWNER_ACCESS = access(OWNER.permissions);
const LEGACY_ADMIN = access([], { isAdmin: true });

describe('the owner role', () => {
  /**
   * The red line. `owner` is what the platform-admin boolean used to be, and
   * that boolean resolves to the whole catalog — so a permission added to the
   * catalog and not to this role is a power an owner silently loses. Failing
   * here is the intended outcome: it asks for a decision instead of taking one.
   */
  it('covers the whole permission catalog except the read-only entry key', () => {
    const missing = ALL_PERMISSIONS.filter(
      (p) => !OWNER.permissions.includes(p),
    );
    expect(missing).toEqual([IAM_PERMISSION.SECTION_VIEW]);
  });

  it('stands above manager rather than beside it', () => {
    for (const p of MANAGER.permissions) {
      expect(OWNER.permissions).toContain(p);
    }
    expect(OWNER.permissions.length).toBeGreaterThan(
      MANAGER.permissions.length,
    );
  });

  it('carries the five permissions the boolean was covering on its own', () => {
    // Each of these replaced an @Admin() gate. Owner holds them because owner is
    // what the boolean became; manager must not, or the conversion would have
    // handed a role that already exists five powers nobody granted it.
    const onlyOwner = [
      IAM_PERMISSION.CLUSTER_DESTROY,
      IAM_PERMISSION.IAM_MANAGE_USERS,
      IAM_PERMISSION.INTEGRATION_MANAGE,
      IAM_PERMISSION.SHOWCASE_PUBLISH,
      IAM_PERMISSION.SANDBOX_OPERATE,
    ];
    for (const permission of onlyOwner) {
      expect(OWNER.permissions).toContain(permission);
      expect(MANAGER.permissions).not.toContain(permission);
    }
  });
});

describe('which roles reach the wire', () => {
  it('is the four a person may grant, and not the two the platform assigns', () => {
    expect(ASSIGNABLE_ROLE_KEYS).toEqual([
      IAM_ROLE.VIEWER,
      IAM_ROLE.EDITOR,
      IAM_ROLE.MANAGER,
      IAM_ROLE.OWNER,
    ]);
    expect(ASSIGNABLE_ROLE_KEYS).not.toContain(IAM_ROLE.SANDBOX);
    expect(ASSIGNABLE_ROLE_KEYS).not.toContain(IAM_ROLE.SHOWCASE_VIEWER);
  });
});

describe('who may confer which role', () => {
  it('a manager hands out the ordinary roles', () => {
    for (const role of [IAM_ROLE.VIEWER, IAM_ROLE.EDITOR, IAM_ROLE.MANAGER]) {
      expect(mayConferRole(MANAGER_ACCESS, role)).toBe(true);
    }
  });

  /** The ladder section 8 closed on `PATCH :id/role`, entered through the grant screen. */
  it('a manager cannot make an owner', () => {
    expect(mayConferRole(MANAGER_ACCESS, IAM_ROLE.OWNER)).toBe(false);
  });

  it('an owner can', () => {
    expect(mayConferRole(OWNER_ACCESS, IAM_ROLE.OWNER)).toBe(true);
  });

  it('the legacy platform-admin boolean still can, because it must', () => {
    expect(mayConferRole(LEGACY_ADMIN, IAM_ROLE.OWNER)).toBe(true);
  });

  /**
   * The permission is read at global scope only. A grant that reaches one
   * cluster carries the same permission set as a global one — reading it
   * scope-blind would let an owner of a single cluster appoint the owner of the
   * installation.
   */
  it('holding iam:manage-users on a scope only is not enough', () => {
    const scoped: PrincipalAccess = {
      isAdmin: false,
      globalPermissions: new Set([IAM_PERMISSION.IAM_ASSIGN_ROLE]),
      scopedGrants: [
        {
          permissions: new Set<IamPermission>([
            IAM_PERMISSION.IAM_MANAGE_USERS,
          ]),
          scopeType: 'cluster',
          scopeRef: 'c1',
          selector: null,
        },
      ],
      isSandbox: false,
    };
    expect(mayConferRole(scoped, IAM_ROLE.OWNER)).toBe(false);
  });

  it('nobody hands out the roles the platform assigns itself', () => {
    for (const role of [IAM_ROLE.SANDBOX, IAM_ROLE.SHOWCASE_VIEWER]) {
      expect(mayConferRole(OWNER_ACCESS, role)).toBe(false);
      expect(mayConferRole(LEGACY_ADMIN, role)).toBe(false);
    }
  });
});

describe('who may take a role away', () => {
  /**
   * Revocation is the same ladder descended: a manager able to delete an owner
   * binding could strip the installation of its administrators one row at a
   * time, which arrives at the same place as promoting themselves.
   */
  it('a manager cannot revoke an owner', () => {
    expect(mayAdministerRole(MANAGER_ACCESS, IAM_ROLE.OWNER)).toBe(false);
    expect(mayAdministerRole(OWNER_ACCESS, IAM_ROLE.OWNER)).toBe(true);
  });

  /**
   * But it may remove the bindings it was always able to remove — including the
   * two nobody can *create*. A guest tenancy has to be cleanable by hand.
   */
  it('leaves every other role where it was', () => {
    for (const role of [
      IAM_ROLE.VIEWER,
      IAM_ROLE.EDITOR,
      IAM_ROLE.MANAGER,
      IAM_ROLE.SANDBOX,
      IAM_ROLE.SHOWCASE_VIEWER,
    ]) {
      expect(mayAdministerRole(MANAGER_ACCESS, role)).toBe(true);
    }
  });

  it('a role nobody declared is nobody’s to protect', () => {
    expect(mayAdministerRole(MANAGER_ACCESS, 'legacy-role')).toBe(true);
    expect(mayConferRole(MANAGER_ACCESS, 'legacy-role')).toBe(false);
  });
});
