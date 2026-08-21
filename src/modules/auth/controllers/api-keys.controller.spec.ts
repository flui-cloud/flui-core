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

const MANAGER = person('user-manager', 'manager');
const EDITOR = person('user-editor', 'editor');
const GUEST = person('user-guest', 'sandbox');

interface Harness {
  app: INestApplication;
  /** Swapped per test: the principal every request arrives as. */
  as: (principal: Principal) => void;
  keys: Array<Record<string, unknown>>;
  generate: jest.Mock;
  http: () => request.SuperTest<request.Test>;
}

async function harness(initial: Principal): Promise<Harness> {
  let current = initial;
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
    (req: { user: AuthenticatedUser }, _res: unknown, next: () => void) => {
      req.user = current.user;
      next();
    },
  );
  await app.init();

  return {
    app,
    as: (principal) => {
      current = principal;
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
    h = await harness(MANAGER);
  }, BOOT_MS);
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => {
    h.keys.length = 0;
    h.generate.mockClear();
    h.as(MANAGER);
  });

  it('grants exactly the scopes the group names', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'agent', groups: ['apps:change'] })
      .expect(201);

    expect(res.body.scopes).toEqual(APPS_CHANGE);
    expect(res.body.groups).toEqual(['apps:change']);
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

  it('leaves a key unscoped when neither groups nor scopes are asked for', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'unscoped' })
      .expect(201);

    expect(res.body.scopes).toBeNull();
    expect(res.body.groups).toBeNull();
  });
});

describe('api keys — the ceiling, refusing whole', () => {
  inOidcMode();
  let h: Harness;

  beforeAll(async () => {
    h = await harness(EDITOR);
  }, BOOT_MS);
  afterAll(async () => {
    await h.app.close();
  });
  beforeEach(() => {
    h.keys.length = 0;
    h.generate.mockClear();
    h.as(EDITOR);
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

  it('refuses the deep group while the shallow one is still fine', async () => {
    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'delete-please', groups: ['apps:destroy'] })
      .expect(403);
    expect(h.generate).not.toHaveBeenCalled();

    await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'operate-please', groups: ['apps:change'] })
      .expect(201);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('will not let a scoped credential mint a group it does not itself carry', async () => {
    h.as({ ...MANAGER, user: { ...MANAGER.user, scopes: [...APPS_CHANGE] } });

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
    expect(grantable).toEqual([
      'apps:look',
      'apps:change',
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

  it('may not switch on anything that deletes, or anything of anybody else’s', async () => {
    const res = await h.http().get('/auth/api-key-groups').expect(200);
    const refused = res.body
      .filter((g: { grantable: boolean }) => !g.grantable)
      .map((g: { key: string }) => g.key);

    expect(refused).toEqual([
      'apps:destroy',
      'backups:look',
      'backups:change',
      'migrations:look',
      'migrations:change',
      'migrations:destroy',
      'mail:look',
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
    expect(list.body[0].groups).toEqual(['apps:change']);
    expect(list.body[0].scopes).toEqual(APPS_CHANGE);
    expect(list.body[0].ungroupedScopes).toEqual([]);
  });

  it('is refused the delete switch whole', async () => {
    const res = await h
      .http()
      .post('/auth/api-keys')
      .send({ name: 'greedy', groups: ['apps:destroy'] })
      .expect(403);

    expect(res.body.message).toContain('apps:destroy');
    expect(res.body.message).toContain(MCP_SCOPE.APP_DESTRUCTIVE);
  });
});
