/* eslint-disable sonarjs/assertions-in-tests --
   The assertion here is supertest's own `.expect(status)`, which throws on a
   mismatch. The rule only recognises a global `expect()`. */

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import {
  Controller,
  Delete,
  Get,
  INestApplication,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { SandboxFenceGuard } from './sandbox-fence.guard';
import { POLICY_ENGINE } from '../../iam/interfaces/policy-engine.interface';
import { PrincipalAccess } from '../../iam/interfaces/iam.types';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { SandboxScopeService } from '../services/sandbox-scope.service';
import {
  SANDBOX_SIGN_IN_REQUIRED_CODE,
  SANDBOX_SIGN_IN_REQUIRED_MESSAGE,
} from '../constants/sandbox-visitor';

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

  @Post('catalog/:slug/install')
  install() {
    return { ok: true };
  }

  @Post('sandbox/keep')
  keep() {
    return { ok: true };
  }

  @Post('repositories/github/connect-pat')
  connectPat() {
    return { ok: true };
  }

  @Post('auth/api-keys')
  mint() {
    return { ok: true };
  }

  @Delete('auth/api-keys/:id')
  revoke() {
    return { ok: true };
  }

  @Post('mcp')
  mcp() {
    return { ok: true };
  }

  @Post('assistant/v1/agent')
  agent() {
    return { ok: true };
  }

  @Patch('applications/:id')
  patchApp() {
    return { ok: true };
  }

  @Put('applications/:id/env')
  putEnv() {
    return { ok: true };
  }

  @Delete('applications/:id')
  deleteApp() {
    return { ok: true };
  }

  @Get('access/ssh-keys')
  sshKeys() {
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

describe('SandboxFenceGuard and a visitor who has not signed in', () => {
  let app: INestApplication;
  let resolved: PrincipalAccess;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [Routes],
      providers: [
        { provide: APP_GUARD, useClass: SandboxFenceGuard },
        {
          provide: SandboxScopeService,
          useValue: { resolve: async () => ({ clusterId: 'c1' }) },
        },
        {
          provide: POLICY_ENGINE,
          useValue: { resolveAccess: async () => resolved },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(
      (req: { user: AuthenticatedUser }, _res: unknown, next: () => void) => {
        req.user = {
          userId: 'v-1',
          email: 'visitor-1a2b3c4d@visitors.invalid',
          roles: {},
          role: IdentityRole.USER,
          isAdmin: false,
        };
        next();
      },
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('as a visitor', () => {
    beforeEach(() => {
      resolved = access({ isSandbox: true, isVisitor: true });
    });

    it('reads what a guest reads', async () => {
      await http().get('/applications/app-1/logs').expect(200);
    });

    it.each([
      ['/clusters/c1/applications'],
      ['/catalog/redis/install'],
      ['/sandbox/keep'],
      ['/repositories/github/connect-pat'],
    ])('is asked to sign in for POST %s', async (path) => {
      const res = await http().post(path).expect(401);
      expect(res.body.code).toBe(SANDBOX_SIGN_IN_REQUIRED_CODE);
      expect(res.body.message).toBe(SANDBOX_SIGN_IN_REQUIRED_MESSAGE);
    });

    it.each([
      ['patch', '/applications/app-1'],
      ['put', '/applications/app-1/env'],
      ['delete', '/applications/app-1'],
    ] as const)('is asked to sign in for %s %s', async (verb, path) => {
      const res = await http()[verb](path).expect(401);
      expect(res.body.code).toBe(SANDBOX_SIGN_IN_REQUIRED_CODE);
    });

    it('connects an agent and talks to the assistant', async () => {
      await http().post('/auth/api-keys').expect(201);
      await http().delete('/auth/api-keys/k-1').expect(200);
      await http().post('/mcp').expect(201);
      await http().post('/assistant/v1/agent').expect(201);
    });

    it('is still refused, not asked to sign in, where no guest may go', async () => {
      const res = await http().get('/access/ssh-keys').expect(403);
      expect(res.body.code).not.toBe(SANDBOX_SIGN_IN_REQUIRED_CODE);
    });
  });

  describe('as a signed-in guest', () => {
    beforeEach(() => {
      resolved = access({ isSandbox: true, isVisitor: false });
    });

    it('keeps every write the fence admits', async () => {
      await http().post('/clusters/c1/applications').expect(201);
      await http().post('/sandbox/keep').expect(201);
    });
  });
});
