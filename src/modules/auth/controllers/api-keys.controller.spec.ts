/* eslint-disable sonarjs/assertions-in-tests --
   The assertion is supertest's own `.expect(status)`, which throws on a
   mismatch; the rule only recognises a global `expect()`. */

// Same reason as `clusters.controller.fence.spec.ts`: the controller's import
// graph reaches ESM-only packages ts-jest cannot transform, and this suite
// touches none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({
  __esModule: true,
  default: class {},
}));

import { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import { ApiKeysController } from './api-keys.controller';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ApiKeyService } from '../services/api-key.service';
import { LocalAuthService } from '../services/local-auth.service';
import { OidcBootstrapService } from '../services/oidc-bootstrap.service';
import { OidcProfileSyncService } from '../services/oidc-profile-sync.service';
import { ConfigureAuthModeService } from '../../dns/services/configure-auth-mode.service';
import { UserEntity, IdentityRole } from '../entities/user.entity';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { POLICY_ENGINE } from '../../iam/interfaces/policy-engine.interface';
import { PolicyEngineService } from '../../iam/services/policy-engine.service';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IamGroupEntity } from '../../iam/entities/iam-group.entity';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { findPermissionGroup } from '../constants/api-key-groups';
import { CURRENT_API_KEY_ID } from '../strategies/api-key.strategy';

/**
 * A group is the unit of consent, not a second authorization system — so what
 * is worth testing is that it cannot become one: it grants exactly the scopes
 * it names, it is refused whole when it exceeds the issuer, and a key reads
 * back as the group a person switched on.
 *
 * Real `ApiKeysController`, real `PolicyEngineService`, real ceiling. Only the
 * binding store and the key store are fakes.
 */

const APPS_CHANGE = [
  MCP_SCOPE.CATALOG_READ,
  MCP_SCOPE.APP_READ,
  // Operating includes reading the logs of what you operated: without this the
  // group ships a switch that deploys and then goes blind.
  MCP_SCOPE.OBS_READ,
  MCP_SCOPE.SPEC_VALIDATE,
  MCP_SCOPE.APP_WRITE,
];

interface Principal {
  user: AuthenticatedUser;
  role: string;
}

const person = (id: string, role: string): Principal => ({
  user: {
    userId: id,
    email: `${id}@flui.cloud`,
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
  role,
});

const MAINTAINER = person('user-maintainer', 'maintainer');
const OPERATOR = person('user-operator', 'operator');
const GUEST = person('user-guest', 'sandbox');

interface Harness {
  app: INestApplication;
  /** Swapped per test: the principal every request arrives as. */
  as: (principal: Principal) => void;
  /** Which key row the request is authenticated by, as JwtAuthGuard would park it. */
  withKey: (id: string | undefined) => void;
  keys: Array<Record<string, unknown>>;
  generate: jest.Mock;
  http: () => request.SuperTest<request.Test>;
}

async function harness(initial: Principal): Promise<Harness> {
  let current = initial;
  let currentKeyId: string | undefined;
  const keys: Array<Record<string, unknown>> = [];

  const generate = jest.fn(
    async (
      name: string,
      userId: string,
      expiresAt: Date | undefined,
      scopes: string[] | undefined,
    ) => {
      const entity = {
        id: `key-${keys.length + 1}`,
        name,
        userId,
        revoked: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: expiresAt ?? null,
        scopes: scopes?.length ? scopes : null,
      };
      keys.push(entity);
      return { entity, plaintext: 'flui_test-key' };
    },
  );

  const bindingsRepo = {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      const chain = () => qb;
      qb.where = chain;
      qb.orWhere = chain;
      qb.getMany = async () => [
        {
          principalType: 'user',
          principalRef: current.user.userId,
          role: current.role,
          scopeType: 'global',
          scopeRef: null,
          selector: null,
        },
      ];
      return qb;
    },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ApiKeysController],
    providers: [
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
      { provide: getRepositoryToken(UserEntity), useValue: {} },
      {
        provide: ApiKeyService,
        useValue: {
          generateApiKey: (...args: unknown[]) =>
            (generate as (...a: unknown[]) => unknown)(...args),
          listForUser: async (userId: string) =>
            keys.filter((k) => k.userId === userId),
        },
      },
      { provide: LocalAuthService, useValue: {} },
      { provide: ConfigureAuthModeService, useValue: {} },
      { provide: OidcBootstrapService, useValue: {} },
      { provide: OidcProfileSyncService, useValue: {} },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  app.use(
    (
      req: { user: AuthenticatedUser } & Record<symbol, unknown>,
      _res: unknown,
      next: () => void,
    ) => {
      req.user = current.user;
      req[CURRENT_API_KEY_ID] = currentKeyId;
      next();
    },
  );
  await app.init();

  return {
    app,
    as: (principal) => {
      current = principal;
    },
    withKey: (id) => {
      currentKeyId = id;
    },
    keys,
    generate,
    http: () => request(app.getHttpServer()) as never,
  };
}

/**
 * Compiling the testing module walks the controller's whole import graph, which
 * has gone past jest's 5s hook default when the full suite runs it alongside a
 * hundred other files. The work is the same; only the budget changes.
 */
const BOOT_MS = 30_000;

/** API keys only exist in OIDC mode; the route answers 501 otherwise. */
function inOidcMode() {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'oidc';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  });
}

describe('api keys — issuing by group', () => {
  inOidcMode();
  let h: Harness;

  beforeAll(async () => {
    h = await harness(MAINTAINER);
  }, BOOT_MS);
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => {
    h.keys.length = 0;
    h.generate.mockClear();
    h.as(MAINTAINER);
  });

  it('grants exactly the scopes the group names', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'agent', groups: ['apps:change'] })
      .expect(201);

    expect(res.body.scopes).toEqual(APPS_CHANGE);
    expect(res.body.groups).toEqual(['apps:change', 'observability:look']);
    expect(res.body.ungroupedScopes).toEqual([]);
  });

  it('asks for four things in one word', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'watcher', groups: ['apps:look', 'observability:look'] })
      .expect(201);

    expect(res.body.groups).toEqual(['apps:look', 'observability:look']);
    expect(res.body.scopes).toEqual([
      MCP_SCOPE.CATALOG_READ,
      MCP_SCOPE.APP_READ,
      MCP_SCOPE.OBS_READ,
      MCP_SCOPE.SPEC_VALIDATE,
    ]);
  });

  it('unions a group with a hand-picked scope, in canonical order', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({
        name: 'mixed',
        groups: ['apps:look'],
        scopes: [MCP_SCOPE.MIGRATION_READ],
      })
      .expect(201);

    expect(res.body.scopes).toEqual([
      MCP_SCOPE.CATALOG_READ,
      MCP_SCOPE.APP_READ,
      MCP_SCOPE.MIGRATION_READ,
      MCP_SCOPE.SPEC_VALIDATE,
    ]);
    expect(res.body.groups).toEqual(['apps:look', 'migrations:look']);
  });

  it('refuses an unknown group instead of ignoring it', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'typo', groups: ['apps:everything'] })
      .expect(400);

    expect(res.body.message).toContain('apps:everything');
    expect(h.generate).not.toHaveBeenCalled();
  });

  /**
   * The widest credential on the instance is no longer the one nobody asked
   * for. The screen that mints these keys already refused an
   * empty request — "A key with nothing switched on would carry your full
   * weight, so at least one is required" — while the API read the same silence
   * as consent to everything. Two surfaces of one product, opposite answers.
   */
  it('refuses a request naming neither groups nor scopes nor unscoped', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'unscoped' })
      .expect(400);

    expect(res.body.message).toContain('unscoped: true');
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('still issues the unscoped key when it is asked for out loud', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'unscoped', unscoped: true })
      .expect(201);

    expect(res.body.scopes).toBeNull();
    expect(res.body.groups).toBeNull();
  });

  it('refuses a request that asks for both at once', async () => {
    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'both', unscoped: true, groups: ['apps:look'] })
      .expect(400);

    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe('api keys — the ceiling, refusing whole', () => {
  inOidcMode();
  let h: Harness;

  beforeAll(async () => {
    h = await harness(OPERATOR);
  }, BOOT_MS);
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => {
    h.keys.length = 0;
    h.generate.mockClear();
    h.as(OPERATOR);
  });

  it('refuses a group above the issuer, and grants nothing at all', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'too-much', groups: ['apps:look', 'backups:change'] })
      .expect(403);

    // The refusal names the switch, not only the scope: a person cannot act on
    // "mcp:backup:read" if they never saw that word on the screen.
    expect(res.body.message).toContain('backups:change');
    expect(res.body.message).toContain(MCP_SCOPE.BACKUP_READ);
    // And nothing was trimmed down to the part that was allowed.
    expect(h.generate).not.toHaveBeenCalled();
  });

  /**
   * The depth an operator may hand on, and it reaches the delete.
   *
   * It did not, while the rung above the viewer was called `editor` and stopped
   * short of `app:delete`. That stop was removed on purpose: refusing a trusted
   * colleague the verb the anonymous guest of the public demo already holds was
   * not defensible, and what protects an application from a careless removal is
   * the selector the grant carries, not the amputation of the verb from a whole
   * role. So `apps:destroy` is now inside an operator's ceiling — and
   * `backups:change`, one section over, still is not: the ceiling did not
   * dissolve, it moved by exactly one permission.
   */
  it('mints the delete of the applications it reaches, and still not the backups', async () => {
    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'delete-please', groups: ['apps:destroy'] })
      .expect(201);
    expect(h.generate).toHaveBeenCalledTimes(1);

    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'too-far', groups: ['backups:change'] })
      .expect(403);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('will not let a scoped credential mint a group it does not itself carry', async () => {
    h.as({
      ...MAINTAINER,
      user: { ...MAINTAINER.user, scopes: [...APPS_CHANGE] },
    });

    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'escalate', groups: ['migrations:change'] })
      .expect(403);

    expect(res.body.message).toContain('migrations:change');
    expect(h.generate).not.toHaveBeenCalled();

    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'same-again', groups: ['apps:change'] })
      .expect(201);
  });

  it('tells the caller which switches they may hand on', async () => {
    const res = await h.http().get('/auth/api-key-groups').expect(200);
    const grantable = res.body
      .filter((g: { grantable: boolean }) => g.grantable)
      .map((g: { key: string }) => g.key);

    // migrations:destroy is here because `mcp:migration:destructive` and
    // `mcp:migration:write` are pinned to the same permission in
    // api-key-scopes.ts. The group can express a depth the ceiling does not
    // distinguish — which is what a consent unit is for, and is not a claim
    // that IAM is enforcing that line.
    //
    // apps:destroy is here because the operator holds `app:delete`, which is the
    // whole of what the role model changed about this screen: the switch that
    // says "and it may remove them" is now one a developer can hand to their own
    // agent, within their own selector, without asking an administrator.
    expect(grantable).toEqual([
      'apps:look',
      'apps:change',
      'apps:destroy',
      'observability:look',
      'migrations:look',
      'migrations:change',
      'migrations:destroy',
    ]);
  });
});

/**
 * The guest is the test of the taxonomy, not a corner of it: if "let this agent
 * deploy for me, and nothing else" cannot be said in one switch and one
 * sentence to somebody trying the product, the taxonomy is wrong.
 *
 * What this proves is the ceiling. Two things outside this module still stand
 * between a guest and a working agent — the route fence and the MCP scope
 * resolver; see the section 4 diary — and neither is touched here.
 */
describe('api keys — the guest', () => {
  inOidcMode();
  let h: Harness;

  beforeAll(async () => {
    h = await harness(GUEST);
  }, BOOT_MS);
  afterAll(async () => {
    await h.app.close();
  });

  it('may switch on deploying, and reads it in one sentence', async () => {
    const res = await h.http().get('/auth/api-key-groups').expect(200);
    const deploy = res.body.find(
      (g: { key: string }) => g.key === 'apps:change',
    );

    expect(deploy.grantable).toBe(true);
    expect(deploy.label).toBe(findPermissionGroup('apps:change')!.label);
    expect(deploy.summary.trim().endsWith('.')).toBe(true);
  });

  /**
   * `apps:destroy` left this list when the guest was given `app:delete`.
   *
   * It is the rule working rather than being widened: a principal may confer a
   * group only while holding what it carries, and a guest now holds the delete
   * on its own applications — which is the point, because a fixed quota makes
   * removing what you no longer need the way you make room for the next thing.
   * The reach is unchanged: the four tools the group unlocks go over the wire,
   * where AppAccessGuard still answers "yours?" and the fence still refuses the
   * gateway route that is the instance's, not the tenancy's.
   */
  it('may not switch on anything of anybody else’s', async () => {
    const res = await h.http().get('/auth/api-key-groups').expect(200);
    const refused = res.body
      .filter((g: { grantable: boolean }) => !g.grantable)
      .map((g: { key: string }) => g.key);

    expect(refused).toEqual([
      'backups:look',
      'backups:change',
      'migrations:look',
      'migrations:change',
      'migrations:destroy',
      'mail:look',
      'access:look',
      // The switch decision 91 created, seen from the surface it matters most
      // on: a guest is offered it and cannot turn it on, because conferring a
      // role asks for `iam:assign-role` and a tenancy holds nothing of the kind.
      'access:change',
      // The machine room, once tools reached it. All three ask for
      // `cluster:manage`, which a tenancy does not hold and is not meant to:
      // the cluster is the thing its applications run on, shared with every
      // other guest, and a key issued to deploy an application is not for that
      // reason a key that can power the cluster down.
      'infrastructure:look',
      'infrastructure:change',
      'infrastructure:destroy',
    ]);
  });

  it('gets a key carrying deploy and nothing more, and reads it back as that', async () => {
    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'my-agent', groups: ['apps:change'] })
      .expect(201);

    const list = await h.http().get('/auth/api-keys').expect(200);
    expect(list.body).toHaveLength(1);
    // Both names are true of the same key: `apps:change` carries `mcp:obs:read`,
    // so the derived reading satisfies `observability:look` as well.
    expect(list.body[0].groups).toEqual(['apps:change', 'observability:look']);
    expect(list.body[0].scopes).toEqual(APPS_CHANGE);
    expect(list.body[0].ungroupedScopes).toEqual([]);
  });

  it('may hand its agent the delete of its own applications', async () => {
    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'my-agent-with-delete', groups: ['apps:destroy'] })
      .expect(201);
  });

  it('is still refused a switch it does not hold', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'greedy', groups: ['migrations:destroy'] })
      .expect(403);

    expect(res.body.message).toContain('migrations:destroy');
    expect(res.body.message).toContain(MCP_SCOPE.MIGRATION_DESTRUCTIVE);
  });
});

/**
 * The two fields the screen was asking the API for, and the reason each one
 * cannot be worked out on the client (decisions 70 and 71).
 */
describe('api keys — what the listing and the catalogue say', () => {
  inOidcMode();
  let h: Harness;

  beforeAll(async () => {
    h = await harness(GUEST);
  }, BOOT_MS);
  afterAll(async () => {
    await h.app.close();
  });

  it('marks the row that is serving this very request', async () => {
    h.withKey(undefined);
    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'first', groups: ['apps:look'] })
      .expect(201);
    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'second', groups: ['apps:look'] })
      .expect(201);

    // The names cannot answer this: after `/sandbox/resume` a guest holds
    // `sandbox-<ns>` and `sandbox-resume-<ns>` and either can be the live one.
    h.withKey('key-2');
    const list = await h.http().get('/auth/api-keys').expect(200);
    expect(list.body.map((k: { current: boolean }) => k.current)).toEqual([
      false,
      true,
    ]);
  });

  it('marks nothing when the caller did not arrive with an API key', async () => {
    h.withKey(undefined);
    const list = await h.http().get('/auth/api-keys').expect(200);
    expect(list.body.some((k: { current: boolean }) => k.current)).toBe(false);
  });

  it('never calls a key it has just minted the current one', async () => {
    h.withKey('key-1');
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'third', groups: ['apps:look'] })
      .expect(201);
    expect(res.body.current).toBe(false);
  });

  it('names the scopes that put a group out of reach', async () => {
    const res = await h.http().get('/auth/api-key-groups').expect(200);
    const groups: Array<{
      key: string;
      grantable: boolean;
      blockedScopes: string[];
    }> = res.body;

    const refused = groups.filter((g) => !g.grantable);
    expect(refused.length).toBeGreaterThan(0);
    for (const g of refused) {
      // The whole point: a switch shown off is a switch nobody can attempt, so
      // the precise reason had no way of reaching the person reading it.
      expect(g.blockedScopes.length).toBeGreaterThan(0);
      expect(findPermissionGroup(g.key)!.scopes).toEqual(
        expect.arrayContaining(g.blockedScopes),
      );
    }
    for (const g of groups.filter((x) => x.grantable)) {
      expect(g.blockedScopes).toEqual([]);
    }
  });

  it('passes the last-used trace through untouched', async () => {
    h.withKey(undefined);
    const list = await h.http().get('/auth/api-keys').expect(200);
    // Null is "not seen since the column existed", and the screen must be able
    // to tell that apart from "never used" — so nothing here invents a date.
    for (const k of list.body as Array<{ lastUsedAt: string | null }>) {
      expect(k.lastUsedAt).toBeNull();
    }
  });
});
