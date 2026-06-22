import { AccessPolicyService } from './access-policy.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { ApplyPolicyDto } from '../dto/access-policy.dto';

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
    store: () => store,
  };
}

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
    const doc = await new AccessPolicyService(iam as never).export();
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
    const svc = new AccessPolicyService(iam as never);
    const doc = await svc.export();
    const res = await svc.apply(doc as ApplyPolicyDto);
    expect(res).toEqual({ created: 0, unchanged: 3, deleted: 0, desired: 3 });
    expect(iam.store()).toHaveLength(3);
  });

  it('apply creates only the bindings that are missing', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(iam as never);
    const doc = await svc.export();
    doc.spec.bindings.push({
      principal: { type: 'user', ref: 'c@x.com' },
      role: 'viewer',
      scope: { type: 'global' },
    });
    const res = await svc.apply(doc as ApplyPolicyDto);
    expect(res.created).toBe(1);
    expect(res.unchanged).toBe(3);
    expect(iam.store()).toHaveLength(4);
  });

  it('prune removes bindings the policy omits', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(iam as never);
    const doc = await svc.export();
    doc.spec.bindings = doc.spec.bindings.filter(
      (b) => b.scope.type !== 'cluster',
    );
    const res = await svc.apply({ ...doc, prune: true } as ApplyPolicyDto);
    expect(res.deleted).toBe(1);
    expect(iam.store()).toHaveLength(2);
    expect(iam.store().some((b) => b.scopeType === 'cluster')).toBe(false);
  });

  it('without prune, omitted bindings are kept', async () => {
    const iam = fakeIam(SEED);
    const svc = new AccessPolicyService(iam as never);
    const doc = await svc.export();
    doc.spec.bindings = [];
    const res = await svc.apply(doc as ApplyPolicyDto);
    expect(res).toEqual({ created: 0, unchanged: 0, deleted: 0, desired: 0 });
    expect(iam.store()).toHaveLength(3);
  });
});
