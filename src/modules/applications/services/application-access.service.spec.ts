import { PolicyEngineService } from '../../iam/services/policy-engine.service';
import {
  ApplicationAccessService,
  SANDBOX_CLUSTER_FORBIDDEN_CODE,
} from './application-access.service';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_ROLE } from '../../iam/constants/iam-roles';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { SHOWCASE_GRANT, SHOWCASE_TAG } from '../../iam/constants/iam-showcase';

/**
 * Guards the entity → ResourceAttributes mapping (the part the matrix spec can't
 * see): an app's `category` becomes the selector `type`, its `projectId` is
 * resolved to the project SLUG the selector matches on, and the cluster relation
 * supplies name/provider. If this mapping drifts, scoped grants silently stop
 * matching — so these few rows back the live filtering behaviour.
 */
function policyWith(
  bindings: unknown[],
  groups: Array<{ name: string; members: string[] }> = [],
): PolicyEngineService {
  const bindingsRepo = {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      qb.where = () => qb;
      qb.orWhere = () => qb;
      qb.getMany = async () => bindings;
      return qb;
    },
  };
  const groupsRepo = { find: async () => groups };
  return new PolicyEngineService(bindingsRepo as never, groupsRepo as never);
}

const projectsRepo = {
  findBy: async () => [
    { id: 'p1', slug: 'frontend' },
    { id: 'p2', slug: 'backend' },
  ],
  findOne: async ({ where: { id } }: { where: { id: string } }) =>
    ({ p1: { slug: 'frontend' }, p2: { slug: 'backend' } })[id] ?? null,
};
const clustersRepo = {
  findBy: async () => [{ id: 'c1', name: 'prod', provider: 'hetzner' }],
  findOne: async () => ({ name: 'prod', provider: 'hetzner' }),
};

const sandboxTenantsRepoFor = (
  tenants: Array<{ userId: string; clusterId: string }>,
) => ({
  findOne: async ({ where }: { where: { userId: string; state: string } }) =>
    tenants.find((t) => t.userId === where.userId) ?? null,
});

const appEntity = (slug: string, projectId: string, id?: string) =>
  ({
    id,
    slug,
    category: 'user',
    kind: 'APPLICATION',
    clusterId: 'c1',
    projectId,
    tags: [],
  }) as never;

const USER = {
  userId: 'u',
  email: 'bob@acme.com',
  role: IdentityRole.USER,
  isAdmin: false,
};

const FRONTEND_VIEWER_GROUP = [
  {
    principalType: 'group',
    principalRef: 'fe',
    role: 'viewer',
    scopeType: 'selector',
    scopeRef: null,
    selector: { project: 'frontend' },
  },
];

describe('ApplicationAccessService', () => {
  it('filterReadable keeps only apps the group-scoped viewer may read', async () => {
    const policy = policyWith(FRONTEND_VIEWER_GROUP, [
      { name: 'fe', members: ['bob@acme.com'] },
    ]);
    const svc = new ApplicationAccessService(
      policy as never,
      projectsRepo as never,
      clustersRepo as never,
      sandboxTenantsRepoFor([]) as never,
    );
    const apps = [
      appEntity('web', 'p1'),
      appEntity('web2', 'p1'),
      appEntity('api', 'p2'),
    ];
    const visible = await svc.filterReadable(USER as never, apps);
    expect(visible.map((a) => a.slug).sort()).toEqual(['web', 'web2']);
  });

  it('filterReadable returns everything for an admin', async () => {
    const svc = new ApplicationAccessService(
      policyWith([]) as never,
      projectsRepo as never,
      clustersRepo as never,
      sandboxTenantsRepoFor([]) as never,
    );
    const apps = [appEntity('web', 'p1'), appEntity('api', 'p2')];
    const visible = await svc.filterReadable(
      { ...USER, isAdmin: true } as never,
      apps,
    );
    expect(visible).toHaveLength(2);
  });

  /**
   * A credential ceiling is enforced everywhere a list of applications comes
   * from, not only on the single-app routes `AppAccessGuard` covers — a key
   * scoped to specific apps or projects must not be able to enumerate the
   * rest of the instance through a list endpoint. `isAdmin: true` here is the
   * point of each case: the ceiling has to narrow before the admin bypass
   * gets a chance to return everything, exactly like `AppAccessGuard`.
   */
  it('filterReadable withholds apps outside the applicationIds ceiling, even for an admin', async () => {
    const svc = new ApplicationAccessService(
      policyWith([]) as never,
      projectsRepo as never,
      clustersRepo as never,
      sandboxTenantsRepoFor([]) as never,
    );
    const apps = [
      appEntity('web', 'p1', 'app-1'),
      appEntity('api', 'p2', 'app-2'),
    ];
    const visible = await svc.filterReadable(
      { ...USER, isAdmin: true, applicationIds: ['app-1'] } as never,
      apps,
    );
    expect(visible.map((a) => a.slug)).toEqual(['web']);
  });

  it('filterReadable withholds apps outside the projectIds ceiling, even for an admin', async () => {
    const svc = new ApplicationAccessService(
      policyWith([]) as never,
      projectsRepo as never,
      clustersRepo as never,
      sandboxTenantsRepoFor([]) as never,
    );
    const apps = [
      appEntity('web', 'p1', 'app-1'),
      appEntity('api', 'p2', 'app-2'),
    ];
    const visible = await svc.filterReadable(
      { ...USER, isAdmin: true, projectIds: ['p1'] } as never,
      apps,
    );
    expect(visible.map((a) => a.slug)).toEqual(['web']);
  });

  it('filterReadable unions applicationIds and projectIds rather than intersecting them', async () => {
    const svc = new ApplicationAccessService(
      policyWith([]) as never,
      projectsRepo as never,
      clustersRepo as never,
      sandboxTenantsRepoFor([]) as never,
    );
    const apps = [
      appEntity('web', 'p1', 'app-1'), // reached by applicationIds
      appEntity('api', 'p2', 'app-2'), // reached by projectIds
      appEntity('worker', 'p2', 'app-3'), // reached by projectIds too
    ];
    const visible = await svc.filterReadable(
      {
        ...USER,
        isAdmin: true,
        applicationIds: ['app-1'],
        projectIds: ['p2'],
      } as never,
      apps,
    );
    expect(visible.map((a) => a.slug).sort()).toEqual(['api', 'web', 'worker']);
  });

  it('assertCan allows in-scope writes and throws out of scope', async () => {
    const policy = policyWith([
      {
        principalType: 'user',
        principalRef: 'bob@acme.com',
        role: 'operator',
        scopeType: 'selector',
        scopeRef: null,
        selector: { project: 'frontend' },
      },
    ]);
    const svc = new ApplicationAccessService(
      policy as never,
      projectsRepo as never,
      clustersRepo as never,
      sandboxTenantsRepoFor([]) as never,
    );
    await expect(
      svc.assertCan(USER as never, 'app:write', appEntity('web', 'p1')),
    ).resolves.toBeUndefined();
    await expect(
      svc.assertCan(USER as never, 'app:write', appEntity('api', 'p2')),
    ).rejects.toThrow(/Not allowed/);
  });

  describe('assertCanCreate (app:create attribute-authority)', () => {
    const svcWith = (bindings: unknown[]) =>
      new ApplicationAccessService(
        policyWith(bindings) as never,
        projectsRepo as never,
        clustersRepo as never,
        sandboxTenantsRepoFor([]) as never,
      );

    it('admin may create anywhere', async () => {
      await expect(
        svcWith([]).assertCanCreate({ ...USER, isAdmin: true } as never, {
          clusterId: 'c1',
          category: 'user',
          kind: 'APPLICATION',
        }),
      ).resolves.toMatchObject({ isAdmin: true });
    });

    it('cluster-scoped operator may create on that cluster, not another', async () => {
      const svc = svcWith([
        {
          principalType: 'user',
          principalRef: 'bob@acme.com',
          role: 'operator',
          scopeType: 'cluster',
          scopeRef: 'c1',
          selector: null,
        },
      ]);
      await expect(
        svc.assertCanCreate(USER as never, {
          clusterId: 'c1',
          category: 'user',
        }),
      ).resolves.toBeDefined();
      await expect(
        svc.assertCanCreate(USER as never, {
          clusterId: 'c2',
          category: 'user',
        }),
      ).rejects.toThrow(/create/i);
    });

    it('project-scoped operator cannot conjure a project-less app', async () => {
      const svc = svcWith([
        {
          principalType: 'user',
          principalRef: 'bob@acme.com',
          role: 'operator',
          scopeType: 'selector',
          scopeRef: null,
          selector: { project: 'frontend' },
        },
      ]);
      await expect(
        svc.assertCanCreate(USER as never, {
          clusterId: 'c1',
          category: 'user',
        }),
      ).rejects.toThrow(/create/i);
    });

    it('viewer (no app:create) cannot create', async () => {
      const svc = svcWith([
        {
          principalType: 'user',
          principalRef: 'bob@acme.com',
          role: 'viewer',
          scopeType: 'global',
          scopeRef: null,
          selector: null,
        },
      ]);
      await expect(
        svc.assertCanCreate(USER as never, { clusterId: 'c1' }),
      ).rejects.toThrow(/create/i);
    });

    it('global operator may create', async () => {
      const svc = svcWith([
        {
          principalType: 'user',
          principalRef: 'bob@acme.com',
          role: 'operator',
          scopeType: 'global',
          scopeRef: null,
          selector: null,
        },
      ]);
      await expect(
        svc.assertCanCreate(USER as never, {
          clusterId: 'c1',
          category: 'user',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('assertCanCreate (sandbox tenancy cluster pinning)', () => {
    // The exact binding SandboxTenantService.provision writes: an owner-scoped
    // sandbox grant with no cluster constraint of its own.
    const SANDBOX_BINDING = [
      {
        principalType: 'user',
        principalRef: 'bob@acme.com',
        role: 'sandbox',
        scopeType: 'selector',
        scopeRef: null,
        selector: { owner: 'u' },
      },
    ];

    const guestSvc = (tenants: Array<{ userId: string; clusterId: string }>) =>
      new ApplicationAccessService(
        policyWith(SANDBOX_BINDING) as never,
        projectsRepo as never,
        clustersRepo as never,
        sandboxTenantsRepoFor(tenants) as never,
      );

    it('may create on its own tenancy cluster, and reports being a guest', async () => {
      const svc = guestSvc([{ userId: 'u', clusterId: 'c1' }]);
      await expect(
        svc.assertCanCreate(USER as never, {
          clusterId: 'c1',
          category: 'user',
        }),
      ).resolves.toMatchObject({ isSandbox: true });
    });

    it.each([
      ['c2', 'a foreign cluster'],
      [undefined, 'no cluster at all'],
    ])('is refused on %s (%s)', async (clusterId) => {
      const svc = guestSvc([{ userId: 'u', clusterId: 'c1' }]);
      await expect(
        svc.assertCanCreate(USER as never, {
          clusterId,
          category: 'user',
        }),
      ).rejects.toMatchObject({
        response: { code: SANDBOX_CLUSTER_FORBIDDEN_CODE },
      });
    });

    it('is refused when no claimed tenancy backs the credential', async () => {
      const svc = guestSvc([]);
      await expect(
        svc.assertCanCreate(USER as never, {
          clusterId: 'c1',
          category: 'user',
        }),
      ).rejects.toMatchObject({
        response: { code: SANDBOX_CLUSTER_FORBIDDEN_CODE },
      });
    });
  });
  /**
   * The showcase, from the permission layer rather than from the route fence.
   *
   * A tenancy is written two grants, and this is the pair verbatim: everything
   * whose owner is this guest, plus everything carrying the showcase tag. The
   * third state the demo needs — *not yours, and you see it anyway* — is the
   * second of them, and it is read-only by construction rather than by
   * convention: `showcase_viewer` carries `app:read` and nothing else, so there
   * is no write in the set to take away.
   *
   * Written from the constants, not from the strings: the whole design rests on
   * there being one mark, so a test that spelled `showcase` itself would keep
   * passing after somebody retargeted the grant.
   */
  describe('a guest, and what the platform runs beside it', () => {
    const TENANCY_GRANTS = [
      {
        principalType: 'user',
        principalRef: 'bob@acme.com',
        role: IAM_ROLE.SANDBOX,
        scopeType: 'selector',
        scopeRef: null,
        selector: { owner: 'u' },
      },
      {
        principalType: 'user',
        principalRef: 'bob@acme.com',
        role: SHOWCASE_GRANT.role,
        scopeType: 'selector',
        scopeRef: null,
        selector: SHOWCASE_GRANT.selector,
      },
    ];

    const appRow = (
      slug: string,
      over: { userId?: string | null; tags?: string[] },
    ) =>
      ({
        id: slug,
        slug,
        category: 'user',
        kind: 'APPLICATION',
        clusterId: 'c1',
        projectId: null,
        tags: [],
        userId: null,
        ...over,
      }) as never;

    const MINE = appRow('my-app', { userId: 'u' });
    // Owned by the operator, tagged, and therefore shown.
    const ON_SHOW = appRow('immich', {
      userId: 'operator',
      tags: [SHOWCASE_TAG],
    });
    // Owned by nobody this guest is, and not tagged: the control case that
    // keeps the two assertions below from both passing for the wrong reason.
    const NOT_MINE = appRow('someone-else', { userId: 'other' });

    const guest = () =>
      new ApplicationAccessService(
        policyWith(TENANCY_GRANTS) as never,
        projectsRepo as never,
        clustersRepo as never,
        sandboxTenantsRepoFor([{ userId: 'u', clusterId: 'c1' }]) as never,
      );

    it('sees its own and the showcase, and nothing else on the instance', async () => {
      const visible = await guest().filterReadable(USER as never, [
        MINE,
        ON_SHOW,
        NOT_MINE,
      ]);
      expect(
        visible.map((a) => a.slug).sort((a, b) => a.localeCompare(b)),
      ).toEqual(['immich', 'my-app']);
    });

    it.each([
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_DELETE,
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.SCALE_EXECUTE,
    ])('cannot %s a showcase application', async (action) => {
      await expect(
        guest().assertCan(USER as never, action, ON_SHOW),
      ).rejects.toThrow(/Not allowed/);
      // The same verb on its own application passes, which is what makes the
      // refusal above a fence and not a broken grant.
      await expect(
        guest().assertCan(USER as never, action, MINE),
      ).resolves.toBeUndefined();
    });

    /**
     * The other direction, and the one that would turn the showcase into a
     * noticeboard: the tag is the mark, so anybody able to write a tag can put
     * their own application in front of every other guest on the instance.
     * `PATCH /applications/:id { tags }` asks this exact question before it
     * writes, so this is that door seen from the permission side.
     */
    it('cannot put itself in the window', async () => {
      await expect(guest().mayPublishShowcase(USER as never)).resolves.toBe(
        false,
      );
    });

    it('labels the two apart, so nothing unexplained sits in the list', async () => {
      const summary = await guest().summarise(USER as never, [MINE, ON_SHOW]);
      expect(summary.get('immich')).toMatchObject({
        showcase: true,
        readOnly: true,
      });
      expect(summary.get('my-app')).toMatchObject({
        showcase: false,
        readOnly: false,
      });
    });
  });
});
