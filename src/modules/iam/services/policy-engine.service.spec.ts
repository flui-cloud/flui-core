import { PolicyEngineService } from './policy-engine.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamGroupEntity } from '../entities/iam-group.entity';
import { IamPrincipal, ResourceAttributes } from '../interfaces/iam.types';
import { IdentityRole } from '../../auth/entities/user.entity';

type Binding = Pick<
  IamRoleBindingEntity,
  | 'principalType'
  | 'principalRef'
  | 'role'
  | 'scopeType'
  | 'scopeRef'
  | 'selector'
>;

function makeEngine(
  bindingRows: Binding[],
  groupRows: Array<Pick<IamGroupEntity, 'name' | 'members'>> = [],
): PolicyEngineService {
  const bindingsRepo = {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      qb.where = () => qb;
      qb.orWhere = () => qb;
      qb.getMany = async () => bindingRows;
      return qb;
    },
  };
  const groupsRepo = { find: async () => groupRows };
  return new PolicyEngineService(bindingsRepo as never, groupsRepo as never);
}

const principal = (overrides: Partial<IamPrincipal> = {}): IamPrincipal => ({
  userId: 'sa-1',
  email: 'user@acme.com',
  role: IdentityRole.READONLY, // global floor = viewer (app:read, cluster:read)
  isAdmin: false,
  ...overrides,
});

const dbApp: ResourceAttributes = {
  slug: 'ledger-db',
  type: 'user',
  kind: 'DATABASE',
  clusterId: 'c1',
  project: 'acme',
  tags: ['managed-db', 'internal'],
};
const webApp: ResourceAttributes = {
  slug: 'marketing-site',
  type: 'user',
  kind: 'APPLICATION',
  clusterId: 'c2',
  project: 'marketing',
  tags: ['public'],
};

describe('PolicyEngineService (P3 resource-aware)', () => {
  it('admin → allow-all regardless of resource', async () => {
    const engine = makeEngine([]);
    expect(await engine.check(principal({ isAdmin: true }), 'app:delete')).toBe(
      true,
    );
    expect(
      await engine.check(
        principal({ isAdmin: true }),
        'iam:assign-role',
        webApp,
      ),
    ).toBe(true);
  });

  it('deny-by-default: a non-admin with no bindings has no access', async () => {
    const engine = makeEngine([]);
    expect(await engine.check(principal(), 'app:read', dbApp)).toBe(false);
    expect(await engine.check(principal(), 'app:write', dbApp)).toBe(false);
    // resource-less check is coarse too: nothing granted anywhere
    expect(await engine.check(principal(), 'app:read')).toBe(false);
  });

  it('a global-scope binding grants broad (unscoped) access', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: 'user@acme.com',
        role: 'viewer',
        scopeType: 'global',
        scopeRef: null,
        selector: null,
      },
    ]);
    expect(await engine.check(principal(), 'app:read', dbApp)).toBe(true);
    expect(await engine.check(principal(), 'app:read', webApp)).toBe(true);
    // viewer carries no write
    expect(await engine.check(principal(), 'app:write', dbApp)).toBe(false);
  });

  it('selector grant adds write only on matching kind', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: 'user@acme.com',
        role: 'editor',
        scopeType: 'selector',
        scopeRef: null,
        selector: { kind: 'DATABASE' },
      },
    ]);
    expect(await engine.check(principal(), 'app:write', dbApp)).toBe(true);
    expect(await engine.check(principal(), 'app:write', webApp)).toBe(false);
    // resource-less check is coarse: the grant carries app:write somewhere
    expect(await engine.check(principal(), 'app:write')).toBe(true);
  });

  it('cluster scope matches by clusterId', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: 'user@acme.com',
        role: 'editor',
        scopeType: 'cluster',
        scopeRef: 'c1',
        selector: null,
      },
    ]);
    expect(await engine.check(principal(), 'app:write', dbApp)).toBe(true);
    expect(await engine.check(principal(), 'app:write', webApp)).toBe(false);
  });

  it('tags match ALL-of (containment), not any', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: 'user@acme.com',
        role: 'editor',
        scopeType: 'selector',
        scopeRef: null,
        selector: { tags: ['managed-db', 'internal'] },
      },
    ]);
    expect(await engine.check(principal(), 'app:write', dbApp)).toBe(true);
    // webApp lacks both tags
    expect(await engine.check(principal(), 'app:write', webApp)).toBe(false);
  });

  it('slugs match membership', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: 'user@acme.com',
        role: 'manager',
        scopeType: 'selector',
        scopeRef: null,
        selector: { slugs: ['ledger-db'] },
      },
    ]);
    expect(await engine.check(principal(), 'app:delete', dbApp)).toBe(true);
    expect(await engine.check(principal(), 'app:delete', webApp)).toBe(false);
  });

  it('grant via group membership applies', async () => {
    const engine = makeEngine(
      [
        {
          principalType: 'group',
          principalRef: 'dba',
          role: 'editor',
          scopeType: 'selector',
          scopeRef: null,
          selector: { kind: 'DATABASE' },
        },
      ],
      [{ name: 'dba', members: ['user@acme.com'] }],
    );
    expect(await engine.check(principal(), 'app:write', dbApp)).toBe(true);
  });

  it('getEffectivePermissions unions floor + scoped perms', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: 'user@acme.com',
        role: 'editor',
        scopeType: 'selector',
        scopeRef: null,
        selector: { kind: 'DATABASE' },
      },
    ]);
    const perms = await engine.getEffectivePermissions(principal());
    expect(perms).toContain('app:read'); // from the scoped editor grant
    expect(perms).toContain('app:write'); // from the scoped editor grant
    expect(perms).not.toContain('iam:assign-role'); // nobody granted manager
  });

  it('admin getEffectivePermissions returns all', async () => {
    const engine = makeEngine([]);
    const perms = await engine.getEffectivePermissions(
      principal({ isAdmin: true }),
    );
    expect(perms).toContain('iam:assign-role');
    expect(perms).toContain('app:delete');
  });
});
