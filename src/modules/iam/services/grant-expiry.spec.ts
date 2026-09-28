import { BadRequestException } from '@nestjs/common';
import { PolicyEngineService } from './policy-engine.service';
import { AccessPolicyService } from './access-policy.service';
import { IamService } from './iam.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamPrincipal, PrincipalAccess } from '../interfaces/iam.types';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { mayAdministerRole, mayConferRole } from '../constants/iam-roles';
import { grantClauseOf } from '../grant-clause';

const HOUR = 60 * 60 * 1000;
const past = () => new Date(Date.now() - HOUR);
const future = () => new Date(Date.now() + HOUR);

const principal: IamPrincipal = {
  userId: 'op-1',
  email: 'operator@support.example',
  role: IdentityRole.USER,
  isAdmin: false,
};

function engineWith(rows: Partial<IamRoleBindingEntity>[]) {
  const repo = {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      qb.where = () => qb;
      qb.orWhere = () => qb;
      qb.getMany = async () => rows;
      return qb;
    },
  };
  return new PolicyEngineService(
    repo as never,
    { find: async () => [] } as never,
  );
}

const grant = (over: Partial<IamRoleBindingEntity>) => ({
  principalType: 'user' as const,
  principalRef: principal.email,
  role: 'maintainer',
  scopeType: 'global' as const,
  scopeRef: null,
  selector: null,
  ...over,
});

describe('a grant with an expiry', () => {
  it('counts before it expires', async () => {
    const engine = engineWith([grant({ expiresAt: future() })]);
    await expect(
      engine.check(principal, IAM_PERMISSION.CLUSTER_MANAGE),
    ).resolves.toBe(true);
  });

  it('gives nothing once it has expired, with no job having run', async () => {
    const engine = engineWith([grant({ expiresAt: past() })]);
    await expect(
      engine.check(principal, IAM_PERMISSION.CLUSTER_MANAGE),
    ).resolves.toBe(false);
    expect(await engine.resolveSections(principal)).not.toContain(
      'infrastructure',
    );
  });

  it('leaves a standing grant beside it untouched', async () => {
    const engine = engineWith([
      grant({ expiresAt: past() }),
      grant({ role: 'viewer', expiresAt: null }),
    ]);
    await expect(
      engine.check(principal, IAM_PERMISSION.APP_READ),
    ).resolves.toBe(true);
    await expect(
      engine.check(principal, IAM_PERMISSION.CLUSTER_MANAGE),
    ).resolves.toBe(false);
  });
});

describe('creating a grant with an expiry', () => {
  function service() {
    const saved: Partial<IamRoleBindingEntity>[] = [];
    const bindings = {
      create: (e: Partial<IamRoleBindingEntity>) => e,
      save: async (e: Partial<IamRoleBindingEntity>) => {
        saved.push(e);
        return e;
      },
    };
    const policy = {
      resolveAccess: async (): Promise<PrincipalAccess> => ({
        isAdmin: true,
        globalPermissions: new Set(),
        scopedGrants: [],
        isSandbox: false,
      }),
    };
    const svc = new IamService(
      bindings as never,
      {} as never,
      {} as never,
      {} as never,
      policy as never,
    );
    return { svc, saved };
  }

  const dto = {
    principalType: 'user' as const,
    principalRef: 'operator@support.example',
    role: 'maintainer',
    scopeType: 'global' as const,
  };

  it('records the expiry and who granted it', async () => {
    const { svc, saved } = service();
    const until = future().toISOString();
    await svc.createGrant(
      { ...dto, expiresAt: until },
      {
        ...principal,
        email: 'owner@customer.example',
      },
    );
    expect(saved[0].expiresAt?.toISOString()).toBe(until);
    expect(saved[0].grantedBy).toBe('owner@customer.example');
  });

  it('refuses an expiry that has already passed', async () => {
    const { svc, saved } = service();
    await expect(
      svc.createGrant({ ...dto, expiresAt: past().toISOString() }, principal),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toHaveLength(0);
  });
});

describe('a configuration document and temporary grants', () => {
  function fakeIam(seed: Partial<IamRoleBindingEntity>[]) {
    let store = seed.map((b, i) => ({
      id: `s${i}`,
      ...b,
    })) as IamRoleBindingEntity[];
    return {
      listGrants: async () => store,
      createGrant: async (d: Record<string, unknown>) => {
        const e = {
          id: `n${store.length}`,
          scopeRef: null,
          selector: null,
          ...d,
        } as IamRoleBindingEntity;
        store.push(e);
        return e;
      },
      deleteGrant: async (id: string) => {
        store = store.filter((e) => e.id !== id);
      },
      assertConferrable: (a: PrincipalAccess, role: string) => {
        if (!mayConferRole(a, role)) throw new Error(role);
      },
      assertAdministrable: (a: PrincipalAccess, role: string) => {
        if (!mayAdministerRole(a, role)) throw new Error(role);
      },
      store: () => store,
    };
  }
  const owner = {
    resolveAccess: async (): Promise<PrincipalAccess> => ({
      isAdmin: true,
      globalPermissions: new Set(),
      scopedGrants: [],
      isSandbox: false,
    }),
  };
  const temporary = grant({ expiresAt: future() });

  it('does not export a temporary grant', async () => {
    const iam = fakeIam([temporary]);
    const doc = await new AccessPolicyService(
      iam as never,
      owner as never,
    ).export();
    expect(doc.spec.bindings).toHaveLength(0);
  });

  it('does not prune a temporary grant', async () => {
    const iam = fakeIam([temporary]);
    const result = await new AccessPolicyService(
      iam as never,
      owner as never,
    ).apply(
      {
        apiVersion: 'flui.cloud/v1',
        kind: 'AccessPolicy',
        metadata: { name: 'x' },
        spec: { bindings: [] },
        prune: true,
      } as never,
      principal,
    );
    expect(result.deleted).toBe(0);
    expect(iam.store()).toHaveLength(1);
  });

  it('still creates the standing grant a document names when only a temporary one exists', async () => {
    const iam = fakeIam([temporary]);
    const result = await new AccessPolicyService(
      iam as never,
      owner as never,
    ).apply(
      {
        apiVersion: 'flui.cloud/v1',
        kind: 'AccessPolicy',
        metadata: { name: 'x' },
        spec: {
          bindings: [
            {
              principal: { type: 'user', ref: principal.email },
              role: 'maintainer',
              scope: { type: 'global' },
            },
          ],
        },
      } as never,
      principal,
    );
    expect(result.created).toBe(1);
  });
});

describe('the sentence a person approves', () => {
  it('says until when a temporary grant lasts', () => {
    expect(
      grantClauseOf({
        role: 'maintainer',
        principalType: 'user',
        principalRef: 'op@support.example',
        scopeType: 'global',
        expiresAt: '2026-10-01T18:00:00Z',
      }),
    ).toContain('until 2026-10-01T18:00:00Z');
  });
});
