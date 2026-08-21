import { ForbiddenException } from '@nestjs/common';
import { AccessPolicyService } from './access-policy.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { ApplyPolicyDto } from '../dto/access-policy.dto';
import { IamPrincipal, PrincipalAccess } from '../interfaces/iam.types';
import { mayAdministerRole, mayConferRole } from '../constants/iam-roles';
import { IAM_PERMISSION } from '../constants/iam-permissions';

/** The caller: identity is irrelevant here, the resolved access below is not. */
const CALLER = { userId: 'u1', email: 'a@x.com' } as IamPrincipal;

function accessWith(permissions: string[]): PrincipalAccess {
  return {
    isAdmin: false,
    globalPermissions: new Set(permissions),
    scopedGrants: [],
    isSandbox: false,
  };
}

/**
 * A policy engine that answers one resolved access, and an `iam` fake that
 * applies the *real* conferral rule — the point of these tests is the rule, so
 * re-stating it in a stub would prove only that the stub agrees with itself.
 */
function fakePolicy(access: PrincipalAccess) {
  return { resolveAccess: async () => access };
}

/**
 * Config-as-Code round-trip: export → apply must be a no-op (idempotent), apply
 * of new bindings creates them, and `prune` removes the ones the policy omits.
 */
function fakeIam(seed: Partial<IamRoleBindingEntity>[] = []) {
  let store = seed.map((b, i) => ({
    id: `seed${i}`,
    scopeRef: null,
    selector: null,
    ...b,
  })) as IamRoleBindingEntity[];
  let seq = 0;
  return {
    listGrants: async () => store,
    createGrant: async (dto: Record<string, unknown>) => {
      const e = {
        id: `new${seq++}`,
        scopeRef: dto.scopeRef ?? null,
        selector: dto.selector ?? null,
        ...dto,
      } as IamRoleBindingEntity;
      store.push(e);
      return e;
    },
    deleteGrant: async (id: string) => {
      store = store.filter((e) => e.id !== id);
    },
    assertConferrable: (access: PrincipalAccess, role: string) => {
      if (!mayConferRole(access, role)) throw new ForbiddenException(role);
    },
    assertAdministrable: (access: PrincipalAccess, role: string) => {
      if (!mayAdministerRole(access, role)) throw new ForbiddenException(role);
    },
    store: () => store,
  };
}

/** Whatever an ordinary access-manager holds, plus nothing else. */
const MANAGER_ACCESS = accessWith([IAM_PERMISSION.IAM_ASSIGN_ROLE]);
const OWNER_ACCESS = accessWith([
  IAM_PERMISSION.IAM_ASSIGN_ROLE,
  IAM_PERMISSION.IAM_MANAGE_USERS,
]);

const SEED: Partial<IamRoleBindingEntity>[] = [
  {
    principalType: 'user',
    principalRef: 'a@x.com',
    role: 'viewer',
    scopeType: 'global',
  },
  {
    principalType: 'group',
    principalRef: 'fe',
    role: 'editor',
    scopeType: 'cluster',
    scopeRef: 'c1',
  },
  {
    principalType: 'user',
    principalRef: 'b@x.com',
    role: 'manager',
    scopeType: 'selector',
    selector: { project: 'frontend', tags: ['web', 'public'] },
  },
];

describe('AccessPolicyService', () => {
  it('export maps flat bindings to the nested AccessPolicy shape', async () => {
    const iam = fakeIam(SEED);
    const doc = await new AccessPolicyService(
      iam as never,
      fakePolicy(MANAGER_ACCESS) as never,
    ).export();
    expect(doc.kind).toBe('AccessPolicy');
    expect(doc.spec.bindings).toHaveLength(3);
    const selBinding = doc.spec.bindings.find(
      (b) => b.scope.type === 'selector',
    );
    expect(selBinding?.scope.selector).toEqual({
      project: 'frontend',
      tags: ['web', 'public'],
    });
    const cl = doc.spec.bindings.find((b) => b.scope.type === 'cluster');
    expect(cl?.scope.cluster).toBe('c1');
  });

  it('apply of the exported policy is a no-op (idempotent)', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(
      iam as never,
      fakePolicy(MANAGER_ACCESS) as never,
    );
    const doc = await svc.export();
    const res = await svc.apply(doc as ApplyPolicyDto, CALLER);
    expect(res).toEqual({ created: 0, unchanged: 3, deleted: 0, desired: 3 });
    expect(iam.store()).toHaveLength(3);
  });

  it('apply creates only the bindings that are missing', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(
      iam as never,
      fakePolicy(MANAGER_ACCESS) as never,
    );
    const doc = await svc.export();
    doc.spec.bindings.push({
      principal: { type: 'user', ref: 'c@x.com' },
      role: 'viewer',
      scope: { type: 'global' },
    });
    const res = await svc.apply(doc as ApplyPolicyDto, CALLER);
    expect(res.created).toBe(1);
    expect(res.unchanged).toBe(3);
    expect(iam.store()).toHaveLength(4);
  });

  it('prune removes bindings the policy omits', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(
      iam as never,
      fakePolicy(MANAGER_ACCESS) as never,
    );
    const doc = await svc.export();
    doc.spec.bindings = doc.spec.bindings.filter(
      (b) => b.scope.type !== 'cluster',
    );
    const res = await svc.apply(
      { ...doc, prune: true } as ApplyPolicyDto,
      CALLER,
    );
    expect(res.deleted).toBe(1);
    expect(iam.store()).toHaveLength(2);
    expect(iam.store().some((b) => b.scopeType === 'cluster')).toBe(false);
  });

  it('refuses a document that confers owner to a caller who may not', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(
      iam as never,
      fakePolicy(MANAGER_ACCESS) as never,
    );
    const doc = await svc.export();
    doc.spec.bindings.push({
      principal: { type: 'user', ref: 'self@x.com' },
      role: 'owner',
      scope: { type: 'global' },
    });
    await expect(svc.apply(doc as ApplyPolicyDto, CALLER)).rejects.toThrow(
      ForbiddenException,
    );
    // Refused whole: the three bindings it did not object to are not created
    // either, so a rejected policy never lands halfway.
    expect(iam.store()).toHaveLength(3);
  });

  it('refuses a prune that would remove an owner binding', async () => {
    const iam = fakeIam([
      ...SEED,
      {
        principalType: 'user',
        principalRef: 'owner@x.com',
        role: 'owner',
        scopeType: 'global',
      },
    ]);
    const svc = new AccessPolicyService(
      iam as never,
      fakePolicy(MANAGER_ACCESS) as never,
    );
    const doc = await svc.export();
    doc.spec.bindings = doc.spec.bindings.filter((b) => b.role !== 'owner');
    await expect(
      svc.apply({ ...doc, prune: true } as ApplyPolicyDto, CALLER),
    ).rejects.toThrow(ForbiddenException);
    expect(iam.store()).toHaveLength(4);
  });

  it('an owner may do both', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(
      iam as never,
      fakePolicy(OWNER_ACCESS) as never,
    );
    const doc = await svc.export();
    doc.spec.bindings.push({
      principal: { type: 'user', ref: 'heir@x.com' },
      role: 'owner',
      scope: { type: 'global' },
    });
    const res = await svc.apply(doc as ApplyPolicyDto, CALLER);
    expect(res.created).toBe(1);
    expect(iam.store()).toHaveLength(4);
  });

  it('without prune, omitted bindings are kept', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(
      iam as never,
      fakePolicy(MANAGER_ACCESS) as never,
    );
    const doc = await svc.export();
    doc.spec.bindings = [];
    const res = await svc.apply(doc as ApplyPolicyDto, CALLER);
    expect(res).toEqual({ created: 0, unchanged: 0, deleted: 0, desired: 0 });
    expect(iam.store()).toHaveLength(3);
  });
});
