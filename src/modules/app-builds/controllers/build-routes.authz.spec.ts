/* eslint-disable sonarjs/assertions-in-tests --
   The assertion here is supertest's own `.expect(status)`, which throws on a
   mismatch. The rule only recognises a global `expect()` and reads these as
   assertion-free. */

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
// Only the DI tokens are needed here, and their real modules drag in the build
// agent's Octokit and Kubernetes clients — ESM that ts-jest will not transform.
jest.mock('../services/app-build.service', () => ({
  AppBuildService: class AppBuildService {},
}));
jest.mock('../services/build-cache.service', () => ({
  BuildCacheService: class BuildCacheService {},
}));
jest.mock('../services/build-access.service', () => ({
  BuildAccessService: class BuildAccessService {},
}));
jest.mock('../../applications/services/application-access.service', () => ({
  ApplicationAccessService: class ApplicationAccessService {},
}));

import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { StandaloneBuildsController } from './standalone-builds.controller';
import { BuildNamespaceController } from './build-namespace.controller';
import { BuildAccessService } from '../services/build-access.service';
import { AppBuildService } from '../services/app-build.service';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { BuildCacheService } from '../services/build-cache.service';
import { SectionAccessGuard } from '../../iam/guards/section-access.guard';
import { POLICY_ENGINE } from '../../iam/interfaces/policy-engine.interface';
import { SectionAccess } from '../../iam/constants/iam-sections';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { ForbiddenException } from '@nestjs/common';

/**
 * The two build controllers that carried no authorization decorator at all.
 *
 * A sandbox guest was refused by the route fence, which is a different list for
 * a different reason and covers nobody else. This is the caller the fence never
 * sees: an `operator` scoped to their own applications, holding no infrastructure
 * area — the principal the live proof could not be built for, because there is
 * no product verb that makes one.
 */

const operator: AuthenticatedUser = {
  userId: 'operator-1',
  email: 'operator@example.test',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

describe('the build routes nobody was gating', () => {
  let app: INestApplication;
  let sections: SectionAccess[];
  let mayAct: boolean;
  let mayCreate: boolean;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StandaloneBuildsController, BuildNamespaceController],
      providers: [
        { provide: APP_GUARD, useClass: SectionAccessGuard },
        {
          provide: POLICY_ENGINE,
          useValue: { resolveSectionAccess: async () => sections },
        },
        {
          provide: BuildAccessService,
          useValue: {
            buildForCaller: async () => {
              if (!mayAct) throw new ForbiddenException('Not allowed');
              return { id: 'b1' };
            },
          },
        },
        {
          provide: ApplicationAccessService,
          useValue: {
            assertCanCreate: async () => {
              if (!mayCreate) throw new ForbiddenException('Not allowed');
            },
          },
        },
        {
          provide: AppBuildService,
          useValue: {
            triggerStandaloneBuild: async () => ({ id: 'b1' }),
            deleteStandaloneBuild: async () => undefined,
            getBuildNamespaceResources: async () => ({ jobs: [] }),
            cleanupBuildNamespace: async () => ({ deleted: 0 }),
          },
        },
        {
          provide: BuildCacheService,
          useValue: {
            getCacheInfo: async () => ({ phase: 'Bound' }),
            getCacheBreakdown: async () => ({ scanStatus: 'ok' }),
            requestRefresh: async () => ({ started: false }),
            clearCacheAsync: async () => ({ operationId: 'op-1' }),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(
      (req: { user: AuthenticatedUser }, _res: unknown, next: () => void) => {
        req.user = operator;
        next();
      },
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('a build that is not yours', () => {
    beforeEach(() => {
      sections = [];
      mayAct = false;
      mayCreate = true;
    });

    it('is not readable', async () => {
      await http()
        .get('/builds/11111111-1111-4111-8111-111111111111')
        .expect(403);
    });

    it('is not deletable', async () => {
      await http()
        .delete('/builds/11111111-1111-4111-8111-111111111111')
        .expect(403);
    });
  });

  describe('a build that is yours', () => {
    beforeEach(() => {
      sections = [];
      mayAct = true;
      mayCreate = true;
    });

    it('is readable', async () => {
      await http()
        .get('/builds/11111111-1111-4111-8111-111111111111')
        .expect(200);
    });
  });

  /**
   * Starting a build has no build to ask about yet, so it asks the thing the
   * build is a step towards: may you create an application on that cluster.
   */
  describe('starting a standalone build', () => {
    beforeEach(() => {
      sections = [];
      mayAct = true;
    });

    it('is refused on a cluster you may not create on', async () => {
      mayCreate = false;
      await http()
        .post('/builds')
        .send({
          gitUrl: 'https://example.test/r.git',
          branch: 'main',
          targetClusterId: '22222222-2222-4222-8222-222222222222',
        })
        .expect(403);
    });

    it('is allowed on one you may', async () => {
      mayCreate = true;
      await http()
        .post('/builds')
        .send({
          gitUrl: 'https://example.test/r.git',
          branch: 'main',
          targetClusterId: '22222222-2222-4222-8222-222222222222',
        })
        .expect(201);
    });
  });

  /**
   * The build namespace is the machinery every application on the cluster
   * shares — nobody's application, so nobody's per-application answer.
   */
  describe('the cluster build namespace', () => {
    const cluster = '22222222-2222-4222-8222-222222222222';

    it('is refused to somebody without the area', async () => {
      sections = [{ key: 'workloads', level: 'full' }];
      await http()
        .get(`/clusters/${cluster}/builds/namespace-resources`)
        .expect(403);
    });

    it('is readable at read-only, and not writable', async () => {
      sections = [{ key: 'infrastructure', level: 'read-only' }];
      await http()
        .get(`/clusters/${cluster}/builds/namespace-resources`)
        .expect(200);
      await http().post(`/clusters/${cluster}/builds/cache/clear`).expect(403);
    });

    it('is fully open to somebody who runs the area', async () => {
      sections = [{ key: 'infrastructure', level: 'full' }];
      await http()
        .get(`/clusters/${cluster}/builds/namespace-resources`)
        .expect(200);
      await http().post(`/clusters/${cluster}/builds/cache/clear`).expect(202);
    });
  });
});
