import { PolicyEngineService } from './policy-engine.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamGroupEntity } from '../entities/iam-group.entity';
import { IamPrincipal, ResourceAttributes } from '../interfaces/iam.types';
import { IdentityRole } from '../../auth/entities/user.entity';

/**
 * REGRESSION BATTERY — the management-plane authorization contract.
 *
 * A matrix of personas (how access is granted) × resources × actions, asserting
 * exactly what each principal may see and do. This is the safety net for the
 * deny-by-default model: a non-admin has NO access unless an explicit binding
 * (own / group / global) grants it, and a scoped binding only reaches resources
 * its selector matches. Add a row here before changing role/permission/selector
 * semantics.
 */

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

const USER = 'bob@acme.com';
const principal = (overrides: Partial<IamPrincipal> = {}): IamPrincipal => ({
  userId: 'sa-bob',
  email: USER,
  role: IdentityRole.USER,
  isAdmin: false,
  ...overrides,
});

// ── The fleet under test ──────────────────────────────────────────────────
// 5 "frontend" apps (project=frontend), 2 "backend" apps, 1 managed database,
// 1 system app — spread over two clusters, with tags.
const app = (
  slug: string,
  extra: Partial<ResourceAttributes> = {},
): ResourceAttributes => ({
  slug,
  type: 'user',
  kind: 'APPLICATION',
  clusterId: 'c1',
  clusterName: 'prod',
  provider: 'hetzner',
  tags: [],
  ...extra,
});

const FRONTEND = [
  app('web-store', { project: 'frontend', tags: ['public', 'web'] }),
  app('web-admin', { project: 'frontend', tags: ['web'] }),
  app('web-blog', { project: 'frontend', tags: ['public', 'web'] }),
  app('web-docs', { project: 'frontend', tags: ['public'] }),
  app('web-status', { project: 'frontend', tags: ['public'] }),
];
const BACKEND = [
  app('api-orders', { project: 'backend', clusterId: 'c2', clusterName: 'eu' }),
  app('api-users', { project: 'backend', clusterId: 'c2', clusterName: 'eu' }),
];
const LEDGER_DB = app('ledger-db', {
  project: 'backend',
  kind: 'DATABASE',
  clusterId: 'c2',
  clusterName: 'eu',
  tags: ['managed-db', 'internal'],
});
const SYSTEM_APP = app('grafana', { type: 'system', kind: 'SYSTEM' });
const ALL = [...FRONTEND, ...BACKEND, LEDGER_DB, SYSTEM_APP];

/** Convenience: which slugs can this access read? */
async function readable(
  engine: PolicyEngineService,
  p: IamPrincipal,
): Promise<string[]> {
  const access = await engine.resolveAccess(p);
  return ALL.filter((r) => engine.can(access, 'app:read', r)).map(
    (r) => r.slug,
  );
}

describe('IAM regression matrix (deny-by-default)', () => {
  it('admin sees and may do everything', async () => {
    const engine = makeEngine([]);
    const p = principal({ isAdmin: true });
    expect((await readable(engine, p)).sort()).toEqual(
      ALL.map((a) => a.slug).sort(),
    );
    for (const r of ALL) {
      const access = await engine.resolveAccess(p);
      expect(engine.can(access, 'app:delete', r)).toBe(true);
    }
  });

  it('no bindings → sees nothing, can do nothing (deny-by-default)', async () => {
    const engine = makeEngine([]);
    expect(await readable(engine, principal())).toEqual([]);
    const access = await engine.resolveAccess(principal());
    expect(engine.can(access, 'app:read', FRONTEND[0])).toBe(false);
    expect(engine.can(access, 'app:write', FRONTEND[0])).toBe(false);
  });

  it('group-scoped viewer on project=frontend → reads exactly the 5 frontend apps, no writes', async () => {
    const engine = makeEngine(
      [
        {
          principalType: 'group',
          principalRef: 'front-end',
          role: 'viewer',
          scopeType: 'selector',
          scopeRef: null,
          selector: { project: 'frontend' },
        },
      ],
      [{ name: 'front-end', members: [USER] }],
    );
    expect((await readable(engine, principal())).sort()).toEqual(
      FRONTEND.map((a) => a.slug).sort(),
    );
    const access = await engine.resolveAccess(principal());
    expect(engine.can(access, 'app:read', BACKEND[0])).toBe(false);
    expect(engine.can(access, 'app:write', FRONTEND[0])).toBe(false); // viewer
    expect(engine.can(access, 'app:read', SYSTEM_APP)).toBe(false);
  });

  it('global viewer → reads all, writes none', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'viewer',
        scopeType: 'global',
        scopeRef: null,
        selector: null,
      },
    ]);
    expect((await readable(engine, principal())).length).toBe(ALL.length);
    const access = await engine.resolveAccess(principal());
    expect(engine.can(access, 'app:write', BACKEND[0])).toBe(false);
  });

  it('selector operator on kind=DATABASE → write the db only, nothing else', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'operator',
        scopeType: 'selector',
        scopeRef: null,
        selector: { kind: 'DATABASE' },
      },
    ]);
    expect(await readable(engine, principal())).toEqual(['ledger-db']);
    const access = await engine.resolveAccess(principal());
    expect(engine.can(access, 'app:write', LEDGER_DB)).toBe(true);
    expect(engine.can(access, 'app:write', FRONTEND[0])).toBe(false);
  });

  it('selector on cluster=c2 → only the eu-cluster apps', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'operator',
        scopeType: 'cluster',
        scopeRef: 'c2',
        selector: null,
      },
    ]);
    expect((await readable(engine, principal())).sort()).toEqual(
      ['api-orders', 'api-users', 'ledger-db'].sort(),
    );
  });

  it('tags match ALL-of: tags=[public,web] → only frontend apps carrying both', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'viewer',
        scopeType: 'selector',
        scopeRef: null,
        selector: { tags: ['public', 'web'] },
      },
    ]);
    expect((await readable(engine, principal())).sort()).toEqual(
      ['web-blog', 'web-store'].sort(),
    );
  });

  it('slugs selector → exactly the hand-picked apps', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'viewer',
        scopeType: 'selector',
        scopeRef: null,
        selector: { slugs: ['web-admin', 'api-users'] },
      },
    ]);
    expect((await readable(engine, principal())).sort()).toEqual(
      ['api-users', 'web-admin'].sort(),
    );
  });

  it('maintainer on project=frontend → may delete frontend apps but not assign roles elsewhere', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'maintainer',
        scopeType: 'selector',
        scopeRef: null,
        selector: { project: 'frontend' },
      },
    ]);
    const access = await engine.resolveAccess(principal());
    expect(engine.can(access, 'app:delete', FRONTEND[0])).toBe(true);
    expect(engine.can(access, 'app:delete', BACKEND[0])).toBe(false);
    // maintainer carries iam:assign-role, but only where the scope reaches
    expect(engine.can(access, 'iam:assign-role', FRONTEND[0])).toBe(true);
    expect(engine.can(access, 'iam:assign-role', BACKEND[0])).toBe(false);
  });

  it('two bindings union: frontend-viewer + db-operator', async () => {
    const engine = makeEngine(
      [
        {
          principalType: 'group',
          principalRef: 'front-end',
          role: 'viewer',
          scopeType: 'selector',
          scopeRef: null,
          selector: { project: 'frontend' },
        },
        {
          principalType: 'user',
          principalRef: USER,
          role: 'operator',
          scopeType: 'selector',
          scopeRef: null,
          selector: { kind: 'DATABASE' },
        },
      ],
      [{ name: 'front-end', members: [USER] }],
    );
    expect((await readable(engine, principal())).sort()).toEqual(
      [...FRONTEND.map((a) => a.slug), 'ledger-db'].sort(),
    );
    const access = await engine.resolveAccess(principal());
    expect(engine.can(access, 'app:write', LEDGER_DB)).toBe(true); // db operator
    expect(engine.can(access, 'app:write', FRONTEND[0])).toBe(false); // frontend viewer
  });

  it('section scope never matches an app resource', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'viewer',
        scopeType: 'section',
        scopeRef: 'catalog',
        selector: null,
      },
    ]);
    expect(await readable(engine, principal())).toEqual([]);
  });
});
