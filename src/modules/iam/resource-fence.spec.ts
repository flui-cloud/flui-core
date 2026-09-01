/* eslint-disable sonarjs/assertions-in-tests --
   The assertion here is supertest's own `.expect(status)`, which throws on a
   mismatch. The rule only recognises a global `expect()` and reads these as
   assertion-free. */

// The guards' import graph reaches ESM-only packages (Kubernetes client, jose via
// jwks-rsa) that ts-jest cannot transform; stub them — this suite touches none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import {
  Controller,
  Get,
  Delete,
  INestApplication,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppAccessGuard } from '../applications/guards/app-access.guard';
import { AppOwnershipGuard } from '../database-console/guards/app-ownership.guard';
import { ApplicationAccessService } from '../applications/services/application-access.service';
import { ApplicationService } from '../applications/services/application.service';
import { ApplicationsRepository } from '../applications/repositories/applications.repository';
import { PolicyEngineService } from './services/policy-engine.service';
import { POLICY_ENGINE } from './interfaces/policy-engine.interface';
import { IAM_PERMISSION } from './constants/iam-permissions';
import { BUILTIN_ROLES, IAM_ROLE } from './constants/iam-roles';
import { SHOWCASE_GRANT } from './constants/iam-showcase';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../auth/entities/user.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectEntity } from '../projects/entities/project.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { SandboxTenantEntity } from '../sandbox/entities/sandbox-tenant.entity';
import { IamRoleBindingEntity } from './entities/iam-role-binding.entity';
import { IamGroupEntity } from './entities/iam-group.entity';

/**
 * The fence, exercised the way an attacker or an agent would: by calling the HTTP
 * routes directly, never through the UI. Everything below the request is real —
 * the guards, the PolicyEngineService, the selector matching; only the storage is
 * stubbed. When the sandbox guest role lands, and when the agent runs as a guest,
 * these are the rows that must stay red.
 */

const CLUSTER = 'cluster-1';
const OTHER_CLUSTER = 'cluster-2';

type Binding = {
  principalType: string;
  principalRef: string;
  role: string;
  scopeType: string;
  scopeRef: string | null;
  selector: Record<string, unknown> | null;
};

const apps: Record<string, Partial<ApplicationEntity>> = {
  'app-a': {
    id: 'app-a',
    slug: 'shop-a',
    category: 'user' as never,
    kind: 'APPLICATION' as never,
    clusterId: CLUSTER,
    projectId: 'p-a',
    userId: 'user-a',
    tags: [],
  },
  'app-b': {
    id: 'app-b',
    slug: 'shop-b',
    category: 'user' as never,
    kind: 'APPLICATION' as never,
    clusterId: CLUSTER,
    projectId: 'p-b',
    userId: 'user-b',
    tags: [],
  },
  'app-orphan': {
    id: 'app-orphan',
    slug: 'seeded-db',
    category: 'user' as never,
    kind: 'APPLICATION' as never,
    clusterId: CLUSTER,
    projectId: null,
    userId: null,
    tags: [],
  },
  'app-elsewhere': {
    id: 'app-elsewhere',
    slug: 'shop-c',
    category: 'user' as never,
    kind: 'APPLICATION' as never,
    clusterId: OTHER_CLUSTER,
    projectId: 'p-b',
    userId: 'user-b',
    tags: [],
  },
  // The showcase: run by the platform's operators, shown to everyone, owned by
  // none of the guests.
  'app-showcase': {
    id: 'app-showcase',
    slug: 'demo-activity',
    category: 'user' as never,
    kind: 'APPLICATION' as never,
    clusterId: CLUSTER,
    projectId: null,
    userId: 'operator-1',
    tags: ['showcase'],
  },
};

const USERS: Record<string, AuthenticatedUser> = {
  admin: {
    userId: 'admin-1',
    email: 'admin@flui.cloud',
    roles: {},
    role: IdentityRole.ADMIN,
    isAdmin: true,
  },
  a: {
    userId: 'user-a',
    email: 'guest-a@try.flui.cloud',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
  b: {
    userId: 'user-b',
    email: 'guest-b@try.flui.cloud',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
  nobody: {
    userId: 'user-n',
    email: 'guest-n@try.flui.cloud',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
};

/** Mirrors the real single-app routes: an IAM-gated one and a console one. */
@Controller('applications')
@UseGuards(AppAccessGuard)
class GatedAppController {
  @Get(':id')
  read(@Param('id') id: string) {
    return { id };
  }

  @Patch(':id')
  write(@Param('id') id: string) {
    return { id };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { id };
  }
}

@Controller('applications')
@UseGuards(AppOwnershipGuard)
class ConsoleController {
  @Get(':id/db/query')
  query(@Param('id') id: string) {
    return { id };
  }
}

/** The list route enforces in the handler, not in a guard — same as the real one. */
@Controller('list')
class ListController {
  constructor(private readonly access: ApplicationAccessService) {}

  @Get()
  async list(@Req() req: { user: AuthenticatedUser }) {
    const visible = await this.access.filterReadable(
      req.user,
      Object.values(apps) as ApplicationEntity[],
    );
    return visible.map((a) => a.slug);
  }

  /** What the interface is told about each app it may draw. */
  @Get('access')
  async summaries(@Req() req: { user: AuthenticatedUser }) {
    const visible = await this.access.filterReadable(
      req.user,
      Object.values(apps) as ApplicationEntity[],
    );
    const summaries = await this.access.summarise(req.user, visible);
    return Object.fromEntries(
      visible.map((a) => [a.slug, summaries.get(a.id!)]),
    );
  }
}

describe('resource fence (direct API calls)', () => {
  let app: INestApplication;
  let bindings: Binding[] = [];
  let principal: AuthenticatedUser = USERS.nobody;

  beforeAll(async () => {
    const bindingsRepo = {
      createQueryBuilder: () => {
        const refs: Array<{ t: string; r: string }> = [];
        const qb: Record<string, unknown> = {};
        const add = (_c: string, p: Record<string, string>) => {
          const i = Object.keys(p)[0].replace('pt', '');
          refs.push({ t: p[`pt${i}`], r: p[`pr${i}`] });
          return qb;
        };
        qb.where = add;
        qb.orWhere = add;
        qb.getMany = async () =>
          bindings.filter((b) =>
            refs.some(
              (ref) => ref.t === b.principalType && ref.r === b.principalRef,
            ),
          );
        return qb;
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [GatedAppController, ConsoleController, ListController],
      providers: [
        AppAccessGuard,
        AppOwnershipGuard,
        ApplicationAccessService,
        { provide: POLICY_ENGINE, useClass: PolicyEngineService },
        PolicyEngineService,
        {
          provide: getRepositoryToken(IamRoleBindingEntity),
          useValue: bindingsRepo,
        },
        {
          provide: getRepositoryToken(IamGroupEntity),
          useValue: { find: async () => [] },
        },
        {
          provide: getRepositoryToken(ProjectEntity),
          useValue: {
            findBy: async () => [
              { id: 'p-a', slug: 'tenant-a' },
              { id: 'p-b', slug: 'tenant-b' },
            ],
            findOne: async ({ where: { id } }: { where: { id: string } }) =>
              ({ 'p-a': { slug: 'tenant-a' }, 'p-b': { slug: 'tenant-b' } })[
                id
              ] ?? null,
          },
        },
        {
          provide: getRepositoryToken(ClusterEntity),
          useValue: {
            findBy: async () => [
              { id: CLUSTER, name: 'control', provider: 'contabo' },
            ],
            findOne: async () => ({ name: 'control', provider: 'contabo' }),
          },
        },
        {
          provide: getRepositoryToken(SandboxTenantEntity),
          useValue: { findOne: async () => null },
        },
        {
          provide: ApplicationService,
          useValue: {
            findById: async (id: string) => {
              if (!apps[id]) throw new Error(`Application ${id} not found`);
              return apps[id];
            },
          },
        },
        {
          provide: ApplicationsRepository,
          useValue: { findById: async (id: string) => apps[id] ?? null },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(
      (req: { user: AuthenticatedUser }, _res: unknown, next: () => void) => {
        req.user = principal;
        next();
      },
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const as = (who: keyof typeof USERS, grants: Binding[] = []) => {
    principal = USERS[who];
    bindings = grants;
  };

  const grant = (
    email: string,
    role: string,
    scope: Partial<Binding>,
  ): Binding => ({
    principalType: 'user',
    principalRef: email,
    role,
    scopeType: 'selector',
    scopeRef: null,
    selector: null,
    ...scope,
  });

  const http = () => request(app.getHttpServer());

  describe('a guest with no grant at all', () => {
    beforeEach(() => as('nobody'));

    it('cannot read any application', async () => {
      await http().get('/applications/app-a').expect(403);
      await http().get('/applications/app-orphan').expect(403);
    });

    it('cannot modify or delete one', async () => {
      await http().patch('/applications/app-a').expect(403);
      await http().delete('/applications/app-a').expect(403);
    });

    it('sees an empty list rather than a filtered hint of others', async () => {
      const res = await http().get('/list').expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('two guests, each scoped to their own project', () => {
    const aGrant = grant('guest-a@try.flui.cloud', 'operator', {
      selector: { project: 'tenant-a' },
    });
    const bGrant = grant('guest-b@try.flui.cloud', 'operator', {
      selector: { project: 'tenant-b' },
    });

    it('lets each read only their own application', async () => {
      as('a', [aGrant, bGrant]);
      await http().get('/applications/app-a').expect(200);
      await http().get('/applications/app-b').expect(403);

      as('b', [aGrant, bGrant]);
      await http().get('/applications/app-b').expect(200);
      await http().get('/applications/app-a').expect(403);
    });

    it('refuses the neighbour a write, not just a read', async () => {
      as('b', [aGrant, bGrant]);
      await http().patch('/applications/app-a').expect(403);
      await http().delete('/applications/app-a').expect(403);
    });

    it('shows each guest only their own row in a list', async () => {
      as('a', [aGrant, bGrant]);
      expect((await http().get('/list').expect(200)).body).toEqual(['shop-a']);

      as('b', [aGrant, bGrant]);
      expect((await http().get('/list').expect(200)).body).toEqual([
        'shop-b',
        'shop-c',
      ]);
    });

    // app:delete is granted to `maintainer` but required by nothing: the guard maps
    // every non-GET verb to app:write, and no route declares @AppAction. The real
    // DELETE /applications/:id is admin-only, which is what actually stops an
    // operator there — not the permission catalog. A sandbox role cannot be fenced
    // by withholding app:delete until some route asks for it.
    it('lets an operator delete through the verb-derived default alone', async () => {
      as('a', [aGrant]);
      await http().delete('/applications/app-a').expect(200);
    });

    it('cannot reach an application that belongs to no project', async () => {
      as('a', [aGrant]);
      await http().get('/applications/app-orphan').expect(403);
    });
  });

  // The boundary a tenancy actually needs: it follows what the guest makes,
  // instead of describing a place the guest was put. Without it a guest could be
  // given applications but never make one — its own creation would land outside
  // every grant it holds.
  describe('a guest scoped to what it owns', () => {
    const ownGrant = grant('guest-a@try.flui.cloud', 'sandbox', {
      selector: { owner: 'user-a' },
    });

    it('reaches its own application and no other', async () => {
      as('a', [ownGrant]);
      await http().get('/applications/app-a').expect(200);
      await http().patch('/applications/app-a').expect(200);
      await http().get('/applications/app-b').expect(403);
    });

    it('never inherits an application nobody owns', async () => {
      as('a', [ownGrant]);
      await http().get('/applications/app-orphan').expect(403);
    });

    it('lists only what it owns', async () => {
      as('a', [ownGrant]);
      expect((await http().get('/list').expect(200)).body).toEqual(['shop-a']);
    });

    it('does not follow the name: a second guest with its own grant sees only its own', async () => {
      as('b', [
        ownGrant,
        grant('guest-b@try.flui.cloud', 'sandbox', {
          selector: { owner: 'user-b' },
        }),
      ]);
      expect((await http().get('/list').expect(200)).body).toEqual([
        'shop-b',
        'shop-c',
      ]);
      await http().get('/applications/app-a').expect(403);
    });
  });

  describe('a cluster-wide grant', () => {
    const clusterGrant = grant('guest-b@try.flui.cloud', 'operator', {
      scopeType: 'cluster',
      scopeRef: CLUSTER,
    });

    // Documents the shape of the boundary: "cluster" is a place, not a tenant.
    // A sandbox guest must never be given one.
    it('reaches every application on that cluster, including the neighbour one', async () => {
      as('b', [clusterGrant]);
      await http().get('/applications/app-a').expect(200);
      await http().get('/applications/app-orphan').expect(200);
      await http().get('/applications/app-elsewhere').expect(403);
    });
  });

  // Decision 221 took the shortcut out of this guard: it used to open on raw
  // `app.userId === user.userId` and never asked IAM at all, so a grant narrowed
  // away from console access applied everywhere in the product except here.
  describe('the console guard, which asks IAM what every other route asks', () => {
    const ownGrant = grant('guest-a@try.flui.cloud', 'sandbox', {
      selector: { owner: 'user-a' },
    });

    it('refuses a console on an application owned by someone else', async () => {
      as('b');
      await http().get('/applications/app-a/db/query').expect(403);
    });

    it('opens the console to an owner whose grant reaches it', async () => {
      as('a', [ownGrant]);
      await http().get('/applications/app-a/db/query').expect(200);
    });

    // Deny-by-default reaches the console too: ownership is what an `owner`
    // selector matches on, never a grant in itself.
    it('refuses the literal owner when no grant reaches the application', async () => {
      as('a');
      await http().get('/applications/app-a/db/query').expect(403);
    });

    // The gap that decided whether a seeded tenant was private, now closed: an
    // application with no owner AND no declared provenance is a registration
    // defect, and it answers absence to everyone but an administrator. Anything
    // the sandbox seeds into a guest namespace must still carry that guest's
    // userId — otherwise the guest cannot reach its own.
    it('answers absence when an application has neither an owner nor a declared provenance', async () => {
      as('nobody');
      await http().get('/applications/app-orphan/db/query').expect(404);
    });
  });

  describe('an admin', () => {
    it('passes both guards everywhere', async () => {
      as('admin');
      await http().get('/applications/app-a').expect(200);
      await http().delete('/applications/app-b').expect(200);
      await http().get('/applications/app-orphan/db/query').expect(200);
    });
  });

  it('never lets a scoped grant leak the permission it does not carry', async () => {
    as('a', [
      grant('guest-a@try.flui.cloud', 'viewer', {
        selector: { project: 'tenant-a' },
      }),
    ]);
    await http().get('/applications/app-a').expect(200);
    await http().patch('/applications/app-a').expect(403);
  });

  it('honours the permission the route asks for, not the HTTP verb alone', () => {
    // AppAccessGuard derives app:read for GET and app:write otherwise; @AppAction
    // overrides it. Kept explicit so a future verb change cannot silently widen it.
    expect(IAM_PERMISSION.APP_READ).toBe('app:read');
    expect(IAM_PERMISSION.APP_WRITE).toBe('app:write');
  });

  /**
   * The showcase is the one place a guest is shown something that is not theirs.
   * It has to be a one-way mirror: everything the read paths offer, nothing the
   * write paths do — and no widening of what the guest reaches elsewhere.
   */
  describe('a sandbox guest and the shared showcase', () => {
    const asGuest = () =>
      as('a', [
        grant('guest-a@try.flui.cloud', IAM_ROLE.SANDBOX, {
          selector: { owner: 'user-a' },
        }),
        grant('guest-a@try.flui.cloud', SHOWCASE_GRANT.role, {
          selector: SHOWCASE_GRANT.selector as Record<string, unknown>,
        }),
      ]);

    it('may read the showcase application', async () => {
      asGuest();
      await http().get('/applications/app-showcase').expect(200);
    });

    it('may not change or delete it', async () => {
      asGuest();
      await http().patch('/applications/app-showcase').expect(403);
      await http().delete('/applications/app-showcase').expect(403);
    });

    it('may not open its database console', async () => {
      // The console guard is ownership-based, not IAM-based: being shown an
      // application must never amount to being handed its data.
      asGuest();
      await http().get('/applications/app-showcase/db/query').expect(403);
    });

    it('still cannot reach a neighbour, tagged or not', async () => {
      asGuest();
      await http().get('/applications/app-b').expect(403);
      await http().get('/applications/app-orphan').expect(403);
    });

    it('sees its own applications and the showcase, and nothing else', async () => {
      asGuest();
      const res = await http().get('/list').expect(200);
      expect(res.body.sort()).toEqual(['demo-activity', 'shop-a']);
    });

    it('is offered read-only tabs on the showcase and the full set on its own', async () => {
      asGuest();
      const res = await http().get('/list/access').expect(200);

      expect(res.body['demo-activity']).toMatchObject({
        readOnly: true,
        showcase: true,
      });
      expect(res.body['demo-activity'].tabs).toEqual(
        expect.arrayContaining(['overview', 'monitoring', 'logs']),
      );
      // The two tabs that render credentials are the ones that must not appear.
      expect(res.body['demo-activity'].tabs).not.toContain('configuration');
      expect(res.body['demo-activity'].tabs).not.toContain('clients');

      expect(res.body['shop-a']).toMatchObject({
        readOnly: false,
        showcase: false,
      });
      expect(res.body['shop-a'].tabs).toContain('configuration');
    });

    it('gains no permission beyond reading from being shown the showcase', async () => {
      // `viewer` would have carried cluster:read here, and a resource-less
      // permission check is satisfied by any scoped grant that holds it.
      expect(BUILTIN_ROLES[SHOWCASE_GRANT.role].permissions).toEqual([
        IAM_PERMISSION.APP_READ,
      ]);
    });
  });
});
