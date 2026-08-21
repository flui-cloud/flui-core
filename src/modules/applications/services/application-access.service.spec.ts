import { PolicyEngineService } from '../../iam/services/policy-engine.service';
import {
  ApplicationAccessService,
  SANDBOX_CLUSTER_FORBIDDEN_CODE,
} from './application-access.service';
import { IdentityRole } from '../../auth/entities/user.entity';

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

const appEntity = (slug: string, projectId: string) =>
  ({
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

  it('assertCan allows in-scope writes and throws out of scope', async () => {
    const policy = policyWith([
      {
        principalType: 'user',
        principalRef: 'bob@acme.com',
        role: 'editor',
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

    it('cluster-scoped editor may create on that cluster, not another', async () => {
      const svc = svcWith([
        {
          principalType: 'user',
          principalRef: 'bob@acme.com',
          role: 'editor',
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

    it('project-scoped editor cannot conjure a project-less app', async () => {
      const svc = svcWith([
        {
          principalType: 'user',
          principalRef: 'bob@acme.com',
          role: 'editor',
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

    it('global editor may create', async () => {
      const svc = svcWith([
        {
          principalType: 'user',
          principalRef: 'bob@acme.com',
          role: 'editor',
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
});
