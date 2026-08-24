import {
  ALL_PERMISSIONS,
  IAM_PERMISSION,
  IamPermission,
} from './iam-permissions';
import {
  ASSIGNABLE_ROLE_KEYS,
  BUILTIN_ROLES,
  IAM_ROLE,
  IamRole,
  ROLE_LADDER,
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
const MAINTAINER = BUILTIN_ROLES[IAM_ROLE.MAINTAINER];

const MAINTAINER_ACCESS = access(MAINTAINER.permissions);
const OWNER_ACCESS = access(OWNER.permissions);
const LEGACY_ADMIN = access([], { isAdmin: true });

/**
 * The decision, and it is this file's reason to exist.
 *
 * `viewer ⊆ operator ⊆ maintainer ⊆ owner` was true of the model nobody had
 * written down and false of the model that was actually shipped: `viewer`
 * carried `cluster:read` and `editor`, the rung above it, did not — so the lower
 * rung opened a section the higher one could not. That was reported as one
 * misplaced permission. It was not: it was the only symptom anybody happened to
 * notice of an invariant that existed solely in people's heads.
 *
 * Fixing the symptom would have left the cause. These three tests are the cause
 * fixed: any future rung that gains a permission its successor lacks fails here,
 * by name, before it reaches a screen.
 */
describe('the ladder', () => {
  it('is cumulative — each rung contains the one below it, permission by permission', () => {
    for (let i = 1; i < ROLE_LADDER.length; i++) {
      const lower = BUILTIN_ROLES[ROLE_LADDER[i - 1]];
      const higher = BUILTIN_ROLES[ROLE_LADDER[i]];
      const missing = lower.permissions.filter(
        (p) => !higher.permissions.includes(p),
      );
      expect({ lower: lower.key, higher: higher.key, missing }).toEqual({
        lower: lower.key,
        higher: higher.key,
        missing: [],
      });
    }
  });

  it('is strictly increasing — a rung that adds nothing is a rung nobody needs', () => {
    for (let i = 1; i < ROLE_LADDER.length; i++) {
      const lower = BUILTIN_ROLES[ROLE_LADDER[i - 1]];
      const higher = BUILTIN_ROLES[ROLE_LADDER[i]];
      expect(higher.permissions.length).toBeGreaterThan(
        lower.permissions.length,
      );
    }
  });

  /**
   * Four rungs, and the count is part of the decision: these are the roles that
   * one day become roles in the identity provider, and six would mean shipping
   * two platform-written tenancies into a place people pick from a list.
   */
  it('is the four roles a person may be given, in order', () => {
    expect(ROLE_LADDER).toEqual([
      IAM_ROLE.VIEWER,
      IAM_ROLE.OPERATOR,
      IAM_ROLE.MAINTAINER,
      IAM_ROLE.OWNER,
    ]);
    expect(ROLE_LADDER).toEqual(ASSIGNABLE_ROLE_KEYS);
  });

  /**
   * The two the platform writes for itself sit outside the ladder, not at the
   * bottom of it: `sandbox` holds writes a `viewer` does not, so asking them to
   * respect the ordering would be asking the wrong question of them.
   */
  it('leaves the platform-written tenancies out of it', () => {
    const outside: IamRole[] = [IAM_ROLE.SANDBOX, IAM_ROLE.SHOWCASE_VIEWER];
    for (const role of outside) {
      expect(ROLE_LADDER).not.toContain(role);
      expect(BUILTIN_ROLES[role].assignable).toBe(false);
    }
  });
});

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

  it('stands above maintainer rather than beside it', () => {
    for (const p of MAINTAINER.permissions) {
      expect(OWNER.permissions).toContain(p);
    }
    expect(OWNER.permissions.length).toBeGreaterThan(
      MAINTAINER.permissions.length,
    );
  });

  /**
   * What the top rung keeps to itself, and it is exactly two.
   *
   * Three of the five that used to be here — the instance's GitHub credentials,
   * the showcase and the demonstration — moved down to `maintainer`, because
   * "keeps the installation running" is the sentence that describes them and
   * that is the rung that sentence names. What stays is what cannot be undone:
   * destroying a cluster, and deciding who else runs the place.
   */
  it('keeps the two irreversible acts to itself', () => {
    const onlyOwner = [
      IAM_PERMISSION.CLUSTER_DESTROY,
      IAM_PERMISSION.IAM_MANAGE_USERS,
    ];
    for (const permission of onlyOwner) {
      expect(OWNER.permissions).toContain(permission);
      expect(MAINTAINER.permissions).not.toContain(permission);
    }
    // And nothing else: the delta between the top two rungs is those two and
    // no third, so a permission added to `owner` alone turns this red.
    const delta = OWNER.permissions.filter(
      (p) => !MAINTAINER.permissions.includes(p),
    );
    expect(delta.sort()).toEqual([...onlyOwner].sort());
  });
});

describe('which roles reach the wire', () => {
  it('is the four a person may grant, and not the two the platform assigns', () => {
    expect(ASSIGNABLE_ROLE_KEYS).toEqual([
      IAM_ROLE.VIEWER,
      IAM_ROLE.OPERATOR,
      IAM_ROLE.MAINTAINER,
      IAM_ROLE.OWNER,
    ]);
    expect(ASSIGNABLE_ROLE_KEYS).not.toContain(IAM_ROLE.SANDBOX);
    expect(ASSIGNABLE_ROLE_KEYS).not.toContain(IAM_ROLE.SHOWCASE_VIEWER);
  });
});

describe('who may confer which role', () => {
  it('a maintainer hands out the three rungs below the top', () => {
    for (const role of [
      IAM_ROLE.VIEWER,
      IAM_ROLE.OPERATOR,
      IAM_ROLE.MAINTAINER,
    ]) {
      expect(mayConferRole(MAINTAINER_ACCESS, role)).toBe(true);
    }
  });

  /** The ladder section 8 closed on `PATCH :id/role`, entered through the grant screen. */
  it('a maintainer cannot make an owner', () => {
    expect(mayConferRole(MAINTAINER_ACCESS, IAM_ROLE.OWNER)).toBe(false);
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
   * Revocation is the same ladder descended: a maintainer able to delete an owner
   * binding could strip the installation of its administrators one row at a
   * time, which arrives at the same place as promoting themselves.
   */
  it('a maintainer cannot revoke an owner', () => {
    expect(mayAdministerRole(MAINTAINER_ACCESS, IAM_ROLE.OWNER)).toBe(false);
    expect(mayAdministerRole(OWNER_ACCESS, IAM_ROLE.OWNER)).toBe(true);
  });

  /**
   * But it may remove the bindings it was always able to remove — including the
   * two nobody can *create*. A guest tenancy has to be cleanable by hand.
   */
  it('leaves every other role where it was', () => {
    for (const role of [
      IAM_ROLE.VIEWER,
      IAM_ROLE.OPERATOR,
      IAM_ROLE.MAINTAINER,
      IAM_ROLE.SANDBOX,
      IAM_ROLE.SHOWCASE_VIEWER,
    ]) {
      expect(mayAdministerRole(MAINTAINER_ACCESS, role)).toBe(true);
    }
  });

  it('a role nobody declared is nobody’s to protect', () => {
    expect(mayAdministerRole(MAINTAINER_ACCESS, 'legacy-role')).toBe(true);
    expect(mayConferRole(MAINTAINER_ACCESS, 'legacy-role')).toBe(false);
  });
});
