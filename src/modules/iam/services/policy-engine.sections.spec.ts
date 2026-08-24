import { PolicyEngineService } from './policy-engine.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamGroupEntity } from '../entities/iam-group.entity';
import { IamPrincipal } from '../interfaces/iam.types';
import { IdentityRole } from '../../auth/entities/user.entity';
import { ALL_SECTION_KEYS } from '../constants/iam-sections';

/**
 * Section visibility is derived scope-aware: management sections (clusters,
 * infrastructure, firewall, providers, backup, projects, access) need the
 * governing permission at GLOBAL scope; workload/deploy accept any scope. This
 * is the safety net for the flagged trap — a project-scoped MAINTAINER carries
 * iam:assign-role, but only inside a selector, so Access/Projects stay hidden.
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

describe('PolicyEngine.resolveSections (deny-by-default, scope-aware)', () => {
  it('admin sees every section', async () => {
    const sections = await makeEngine([]).resolveSections(
      principal({ isAdmin: true }),
    );
    expect(sections.sort()).toEqual([...ALL_SECTION_KEYS].sort());
  });

  it('no bindings → only the always-on sections (home, settings)', async () => {
    const sections = await makeEngine([]).resolveSections(principal());
    expect(sections.sort()).toEqual(['home', 'settings']);
  });

  it('project-scoped MAINTAINER → workloads+deploy but NOT access/projects/infra', async () => {
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
    const sections = await engine.resolveSections(principal());
    // maintainer carries app:read/create (→ workloads, deploy) and iam:assign-role
    // + cluster:manage, but all SCOPED — so no management sections.
    expect(sections).toEqual(
      expect.arrayContaining(['home', 'settings', 'workloads', 'deploy']),
    );
    expect(sections).not.toContain('access');
    expect(sections).not.toContain('projects');
    expect(sections).not.toContain('infrastructure');
    expect(sections).not.toContain('clusters');
  });

  it('GLOBAL maintainer → all management sections appear', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'maintainer',
        scopeType: 'global',
        scopeRef: null,
        selector: null,
      },
    ]);
    const sections = await engine.resolveSections(principal());
    expect(sections).toEqual(
      expect.arrayContaining([
        'workloads',
        'deploy',
        'clusters',
        'infrastructure',
        'firewall',
        'providers',
        'backup',
        'projects',
        'access',
      ]),
    );
  });

  it('GLOBAL viewer → clusters (cluster:read) + workloads, but no manage sections', async () => {
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
    const sections = await engine.resolveSections(principal());
    expect(sections).toContain('clusters'); // cluster:read global
    expect(sections).toContain('workloads'); // app:read
    expect(sections).not.toContain('deploy'); // viewer has no app:create
    expect(sections).not.toContain('infrastructure'); // needs cluster:manage global
    expect(sections).not.toContain('access');
  });

  it('sandbox guest → management sections appear, at read-only', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'sandbox',
        scopeType: 'selector',
        scopeRef: null,
        selector: { owner: USER },
      },
    ]);
    const access = await engine.resolveSectionAccess(principal());
    const level = (key: string) => access.find((a) => a.key === key)?.level;

    // The point of the third state: the menu names them, so they can be opened.
    for (const key of [
      'clusters',
      'infrastructure',
      'firewall',
      'providers',
      'backup',
      'mail',
      'access',
    ]) {
      expect(level(key)).toBe('read-only');
    }
    // Its own things stay full, and what has nothing to show stays shut.
    expect(level('workloads')).toBe('full');
    expect(level('deploy')).toBe('full');
    expect(level('settings')).toBe('full');
    expect(level('projects')).toBeUndefined();
  });

  it('the read-only entry key alone opens nothing at full', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'sandbox',
        scopeType: 'selector',
        scopeRef: null,
        selector: { owner: USER },
      },
    ]);
    const access = await engine.resolveSectionAccess(principal());
    const managementFull = access.filter(
      (a) =>
        a.level === 'full' &&
        !['home', 'settings', 'workloads', 'deploy'].includes(a.key),
    );
    expect(managementFull).toEqual([]);
  });

  it('a global maintainer keeps every management section at full', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'maintainer',
        scopeType: 'global',
        scopeRef: null,
        selector: null,
      },
    ]);
    const access = await engine.resolveSectionAccess(principal());
    expect(access.every((a) => a.level === 'full')).toBe(true);
  });

  /**
   * What the dashboard now leans on. Until `owner` existed, "sees everything"
   * was only expressible as `isAdmin`, so the sidebar kept its own `_isAdmin ||
   * …` shortcut beside the section list. A global owner binding must reach the
   * same answer through the model — otherwise removing that shortcut hides
   * sections from the very people who own the installation.
   */
  it('global OWNER → every section, all of them at full', async () => {
    const engine = makeEngine([
      {
        principalType: 'user',
        principalRef: USER,
        role: 'owner',
        scopeType: 'global',
        scopeRef: null,
        selector: null,
      },
    ]);
    const access = await engine.resolveSectionAccess(principal());
    expect(access.map((a) => a.key).sort()).toEqual(
      [...ALL_SECTION_KEYS].sort(),
    );
    expect(access.every((a) => a.level === 'full')).toBe(true);
  });

  it('scoped operator → workloads+deploy only (no management sections)', async () => {
    const engine = makeEngine(
      [
        {
          principalType: 'group',
          principalRef: 'front-end',
          role: 'operator',
          scopeType: 'selector',
          scopeRef: null,
          selector: { project: 'frontend' },
        },
      ],
      [{ name: 'front-end', members: [USER] }],
    );
    const sections = await engine.resolveSections(principal());
    expect(sections.sort()).toEqual(
      ['deploy', 'home', 'settings', 'workloads'].sort(),
    );
  });
});
