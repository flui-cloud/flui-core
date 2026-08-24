/* eslint-disable sonarjs/assertions-in-tests --
   The assertion here is supertest's own `.expect(status)`, which throws on a
   mismatch. The rule only recognises a global `expect()` and reads these as
   assertion-free. */

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import {
  Controller,
  Delete,
  Get,
  INestApplication,
  Post,
  Put,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { SandboxFenceGuard } from './guards/sandbox-fence.guard';
import { SANDBOX_FORBIDDEN_MESSAGE } from './constants/sandbox-fence';
import { POLICY_ENGINE } from '../iam/interfaces/policy-engine.interface';
import { PrincipalAccess } from '../iam/interfaces/iam.types';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../auth/entities/user.entity';

/**
 * The fence over real HTTP, with the guard mounted globally exactly as the app
 * mounts it. These are the requests an agent would make on a guest's behalf: no
 * interface in the path, no button to hide.
 */

@Controller()
class Routes {
  @Get('applications/:id/logs')
  logs() {
    return { ok: true };
  }

  @Post('clusters/:clusterId/applications')
  create() {
    return { ok: true };
  }

  @Get('infrastructure/clusters')
  clusters() {
    return { ok: true };
  }

  @Get('access/ssh-keys')
  sshKeys() {
    return { ok: true };
  }

  @Get('variables/clusters/:clusterId/namespaces/:namespace')
  variables() {
    return { ok: true };
  }

  @Post('auth/api-keys')
  apiKeys() {
    return { ok: true };
  }

  @Get('auth/api-keys')
  listApiKeys() {
    return { ok: true };
  }

  @Delete('auth/api-keys/:id')
  revokeApiKey() {
    return { ok: true };
  }

  @Get('auth/api-key-groups')
  apiKeyGroups() {
    return { ok: true };
  }

  @Put('auth/api-keys/:id')
  renameApiKey() {
    return { ok: true };
  }

  @Post('mcp')
  mcp() {
    return { ok: true };
  }
}

const access = (over: Partial<PrincipalAccess>): PrincipalAccess => ({
  isAdmin: false,
  globalPermissions: new Set(),
  scopedGrants: [],
  isSandbox: false,
  ...over,
});

describe('SandboxFenceGuard over HTTP', () => {
  let app: INestApplication;
  let principal: AuthenticatedUser;
  let resolved: PrincipalAccess;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [Routes],
      providers: [
        { provide: APP_GUARD, useClass: SandboxFenceGuard },
        {
          provide: POLICY_ENGINE,
          useValue: { resolveAccess: async () => resolved },
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

  const guest = () => {
    principal = {
      userId: 'guest-1',
      email: 'guest@try.flui.cloud',
      roles: {},
      role: IdentityRole.USER,
      isAdmin: false,
    };
    resolved = access({ isSandbox: true });
  };

  const ordinaryUser = () => {
    principal = {
      userId: 'u-1',
      email: 'someone@example.com',
      roles: {},
      role: IdentityRole.USER,
      isAdmin: false,
    };
    resolved = access({ isSandbox: false });
  };

  const admin = () => {
    principal = {
      userId: 'a-1',
      email: 'admin@flui.cloud',
      roles: {},
      role: IdentityRole.ADMIN,
      isAdmin: true,
    };
    resolved = access({ isAdmin: true });
  };

  const http = () => request(app.getHttpServer());

  describe('a sandbox guest', () => {
    beforeEach(guest);

    it('reaches its own application', async () => {
      await http().get('/applications/app-1/logs').expect(200);
      await http().post('/clusters/c1/applications').expect(201);
    });

    // Reachable at the route; what comes back is narrowed by
    // SandboxProjectionInterceptor, which this suite does not install.
    it('reaches the cluster list, which the projection then narrows', async () => {
      await http().get('/infrastructure/clusters').expect(200);
    });

    it.each([
      ['/access/ssh-keys', 'the SSH key surface'],
      ['/variables/clusters/c1/namespaces/flui-system', 'platform variables'],
    ])('is refused %s (%s)', async (path) => {
      const res = await http().get(path).expect(403);
      expect(res.body.code).toBe('SANDBOX_ROUTE_FORBIDDEN');
      // The constant, not a word inside it: the wording is written for a person
      // and is expected to keep improving. What must not change is that the
      // refusal carries the fence's own sentence rather than a bare 403.
      expect(res.body.message).toBe(SANDBOX_FORBIDDEN_MESSAGE);
      expect(res.body.message).not.toContain('/sandbox/limits');
    });

    /**
     * It may now, and this is the one door the whole trial was built to open.
     * What keeps it safe is not this list but the two gates behind it: the key
     * is refused any scope whose permission the guest does not itself hold, and
     * every call the resulting agent makes arrives back at this guard as the
     * guest. What a guest still cannot do is mint a key worth more than itself,
     * and that is `api-key-scopes.ts`, not the fence.
     */
    it('may mint itself an agent credential, and reach the agent endpoint', async () => {
      await http().post('/auth/api-keys').expect(201);
      await http().get('/auth/api-key-groups').expect(200);
      await http().post('/mcp').expect(201);
    });

    /**
     * And may switch it off again. Routes were named, not a controller, so what
     * is open is the pair that undoes the mint above — both of which read and
     * write only the caller's own keys — and nothing else on that controller.
     */
    it('may see and revoke the keys it minted', async () => {
      await http().get('/auth/api-keys').expect(200);
      await http().delete('/auth/api-keys/k1').expect(200);
    });

    it('is opened routes of the key surface, not all of it', async () => {
      const res = await http().put('/auth/api-keys/k1').expect(403);
      expect(res.body.code).toBe('SANDBOX_ROUTE_FORBIDDEN');
    });

    it('names the route it refused, so the refusal is auditable', async () => {
      const res = await http().get('/access/ssh-keys').expect(403);
      expect(res.body.route).toBe('GET /access/ssh-keys');
    });
  });

  it('leaves an ordinary user alone', async () => {
    ordinaryUser();
    await http().get('/infrastructure/clusters').expect(200);
    await http().get('/access/ssh-keys').expect(200);
  });

  it('leaves an admin alone without even resolving access', async () => {
    admin();
    resolved = access({ isSandbox: true }); // would deny, if it were consulted
    await http().get('/infrastructure/clusters').expect(200);
  });
});
