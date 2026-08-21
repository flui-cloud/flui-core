/* eslint-disable sonarjs/assertions-in-tests --
   The assertion here is supertest's own `.expect(status)`, which throws on a
   mismatch. The rule only recognises a global `expect()` and reads these as
   assertion-free. */

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { AppAccessGuard } from '../applications/guards/app-access.guard';
import { ApplicationAccessService } from '../applications/services/application-access.service';
import { ApplicationService } from '../applications/services/application.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AdminGuard } from '../auth/guards/admin.guard';
import { IdentityRole } from '../auth/entities/user.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { SandboxTenantEntity } from '../sandbox/entities/sandbox-tenant.entity';
import { IamGroupEntity } from '../iam/entities/iam-group.entity';
import { IamRoleBindingEntity } from '../iam/entities/iam-role-binding.entity';
import { POLICY_ENGINE } from '../iam/interfaces/policy-engine.interface';
import { PolicyEngineService } from '../iam/services/policy-engine.service';
import { ProjectEntity } from '../projects/entities/project.entity';
import { ApplicationLogsController } from './controllers/application-logs.controller';
import { ApplicationMetricsController } from './controllers/application-metrics.controller';
import { ApplicationTrafficController } from './controllers/application-traffic.controller';
import { ApplicationMetricsService } from './services/application-metrics.service';
import { ApplicationTrafficService } from './services/application-traffic.service';
import { LokiQueryService } from './services/loki-query.service';

const CLUSTER_ID = 'cluster-1';

type Binding = {
  principalType: string;
  principalRef: string;
  role: string;
  scopeType: string;
  scopeRef: string | null;
  selector: Record<string, unknown> | null;
};

const applications = [
  {
    id: 'app-a',
    slug: 'shop-a',
    k8sNamespace: 'tenant-a',
    category: 'user',
    kind: 'APPLICATION',
    clusterId: CLUSTER_ID,
    projectId: 'project-a',
    userId: 'user-a',
    tags: [],
    port: 3000,
    portProtocol: 'http',
  },
  {
    id: 'app-b',
    slug: 'shop-b',
    k8sNamespace: 'tenant-b',
    category: 'user',
    kind: 'APPLICATION',
    clusterId: CLUSTER_ID,
    projectId: 'project-b',
    userId: 'user-b',
    tags: [],
    port: 3000,
    portProtocol: 'http',
  },
] as ApplicationEntity[];

const users: Record<'tenant' | 'admin', AuthenticatedUser> = {
  tenant: {
    userId: 'user-a',
    email: 'tenant-a@example.com',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  },
  admin: {
    userId: 'admin',
    email: 'admin@example.com',
    roles: {},
    role: IdentityRole.ADMIN,
    isAdmin: true,
  },
};

describe('observability resource authorization (direct HTTP routes)', () => {
  let app: INestApplication;
  let principal = users.tenant;
  let bindings: Binding[] = [];
  const lokiQuery = {
    getAppLogs: jest.fn(
      async (clusterId: string, query: Record<string, unknown>) => ({
        cluster_id: clusterId,
        namespace: query.namespace,
        app: query.app,
        count: 0,
        logs: [],
        queried_at: new Date(0).toISOString(),
      }),
    ),
    getAppLogVolume: jest.fn(
      async (clusterId: string, query: Record<string, unknown>) => ({
        cluster_id: clusterId,
        namespace: query.namespace,
        app: query.app,
        range_start: query.start,
        range_end: query.end,
        step: query.step ?? '5m',
        series: [],
        queried_at: new Date(0).toISOString(),
      }),
    ),
  };

  beforeAll(async () => {
    const bindingsRepo = {
      createQueryBuilder: () => {
        const refs: Array<{ type: string; ref: string }> = [];
        const qb: Record<string, unknown> = {};
        const add = (_condition: string, values: Record<string, string>) => {
          const index = Object.keys(values)[0].replace('pt', '');
          refs.push({
            type: values[`pt${index}`],
            ref: values[`pr${index}`],
          });
          return qb;
        };
        qb.where = add;
        qb.orWhere = add;
        qb.getMany = async () =>
          bindings.filter((binding) =>
            refs.some(
              (ref) =>
                ref.type === binding.principalType &&
                ref.ref === binding.principalRef,
            ),
          );
        return qb;
      },
    };
    const applicationService = {
      findById: async (id: string) =>
        applications.find((item) => item.id === id),
      findByClusterId: async (clusterId: string) =>
        applications.filter((item) => item.clusterId === clusterId),
    };
    const metrics = {
      getAppsMetricsInstant: jest.fn(async (items: ApplicationEntity[]) =>
        items.map((item) => ({ app_id: item.id, app_name: item.slug })),
      ),
      getAppsMetricsHistory: jest.fn(async (items: ApplicationEntity[]) =>
        items.map((item) => ({
          app_id: item.id,
          app_name: item.slug,
          namespace: item.k8sNamespace,
          data_points: [],
        })),
      ),
    };
    const traffic = {
      getClusterTrafficByService: jest.fn(async () => new Map()),
      buildTraefikServiceId: (target: { slug: string; namespace: string }) =>
        `${target.namespace}-${target.slug}`,
      isRoutable: () => true,
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [
        ApplicationLogsController,
        ApplicationMetricsController,
        ApplicationTrafficController,
      ],
      providers: [
        AppAccessGuard,
        AdminGuard,
        ApplicationAccessService,
        PolicyEngineService,
        { provide: POLICY_ENGINE, useExisting: PolicyEngineService },
        { provide: ApplicationService, useValue: applicationService },
        { provide: LokiQueryService, useValue: lokiQuery },
        { provide: ApplicationMetricsService, useValue: metrics },
        { provide: ApplicationTrafficService, useValue: traffic },
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
              { id: 'project-a', slug: 'tenant-a' },
              { id: 'project-b', slug: 'tenant-b' },
            ],
            findOne: async ({ where: { id } }: { where: { id: string } }) =>
              id === 'project-a'
                ? { id, slug: 'tenant-a' }
                : { id, slug: 'tenant-b' },
          },
        },
        {
          provide: getRepositoryToken(ClusterEntity),
          useValue: {
            findBy: async () => [
              { id: CLUSTER_ID, name: 'shared', provider: 'test' },
            ],
            findOne: async () => ({
              id: CLUSTER_ID,
              name: 'shared',
              provider: 'test',
            }),
          },
        },
        {
          provide: getRepositoryToken(SandboxTenantEntity),
          useValue: { findOne: async () => null },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
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

  beforeEach(() => {
    principal = users.tenant;
    bindings = [
      {
        principalType: 'user',
        principalRef: users.tenant.email,
        role: 'viewer',
        scopeType: 'selector',
        scopeRef: null,
        selector: { project: 'tenant-a' },
      },
    ];
    jest.clearAllMocks();
  });

  const http = () => request(app.getHttpServer());

  it('blocks non-admin cluster log queries even with a foreign namespace', async () => {
    await http()
      .get(`/observability/clusters/${CLUSTER_ID}/apps/logs`)
      .query({ namespace: 'tenant-b' })
      .expect(403);
    await http()
      .get(`/observability/clusters/${CLUSTER_ID}/apps/logs/volume`)
      .query({
        namespace: 'tenant-b',
        start: '2026-08-16T00:00:00.000Z',
        end: '2026-08-16T01:00:00.000Z',
      })
      .expect(403);
    expect(lokiQuery.getAppLogs).not.toHaveBeenCalled();
    expect(lokiQuery.getAppLogVolume).not.toHaveBeenCalled();
  });

  // The diagnostic route reads a sample line from every stream in the cluster,
  // so it hands out somebody's log content without ever naming a namespace —
  // a shape that reads as harmless and is not.
  it('blocks the Loki diagnostic route for a non-admin', async () => {
    await http().get('/observability/loki/debug').expect(403);
  });

  it('filters both cluster metric routes and cluster traffic to readable apps', async () => {
    const metrics = await http()
      .get(`/observability/clusters/${CLUSTER_ID}/applications/metrics`)
      .expect(200);
    const history = await http()
      .get(`/observability/clusters/${CLUSTER_ID}/applications/metrics/history`)
      .query({
        start: '2026-08-16T00:00:00.000Z',
        end: '2026-08-16T01:00:00.000Z',
      })
      .expect(200);
    const traffic = await http()
      .get(`/observability/clusters/${CLUSTER_ID}/traffic`)
      .expect(200);

    expect(
      metrics.body.applications.map((item: { app_id: string }) => item.app_id),
    ).toEqual(['app-a']);
    expect(
      history.body.applications.map((item: { app_id: string }) => item.app_id),
    ).toEqual(['app-a']);
    expect(
      traffic.body.applications.map((item: { app_id: string }) => item.app_id),
    ).toEqual(['app-a']);
  });

  it('guards per-app logs and derives the Loki selectors from the application', async () => {
    await http()
      .get('/observability/applications/app-b/logs')
      .query({ namespace: 'tenant-a' })
      .expect(403);

    await http()
      .get('/observability/applications/app-a/logs')
      .query({ namespace: 'tenant-b', app: 'shop-b', container: 'shop-b' })
      .expect(200);
    expect(lokiQuery.getAppLogs).toHaveBeenCalledWith(
      CLUSTER_ID,
      expect.objectContaining({
        namespace: 'tenant-a',
        container: 'shop-a',
      }),
    );
    expect(lokiQuery.getAppLogs.mock.calls[0][1].app).toBeUndefined();

    await http()
      .get('/observability/applications/app-a/logs/volume')
      .query({
        namespace: 'tenant-b',
        container: 'shop-b',
        start: '2026-08-16T00:00:00.000Z',
        end: '2026-08-16T01:00:00.000Z',
      })
      .expect(200);
    expect(lokiQuery.getAppLogVolume).toHaveBeenCalledWith(
      CLUSTER_ID,
      expect.objectContaining({
        namespace: 'tenant-a',
        container: 'shop-a',
      }),
    );
  });

  it('preserves admin access to cluster-wide observability', async () => {
    principal = users.admin;

    await http()
      .get(`/observability/clusters/${CLUSTER_ID}/apps/logs`)
      .query({ namespace: 'tenant-b' })
      .expect(200);
    await http()
      .get(`/observability/clusters/${CLUSTER_ID}/apps/logs/volume`)
      .query({
        namespace: 'tenant-b',
        start: '2026-08-16T00:00:00.000Z',
        end: '2026-08-16T01:00:00.000Z',
      })
      .expect(200);
    const metrics = await http()
      .get(`/observability/clusters/${CLUSTER_ID}/applications/metrics`)
      .expect(200);
    const history = await http()
      .get(`/observability/clusters/${CLUSTER_ID}/applications/metrics/history`)
      .query({
        start: '2026-08-16T00:00:00.000Z',
        end: '2026-08-16T01:00:00.000Z',
      })
      .expect(200);
    const traffic = await http()
      .get(`/observability/clusters/${CLUSTER_ID}/traffic`)
      .expect(200);

    expect(metrics.body.applications).toHaveLength(2);
    expect(history.body.applications).toHaveLength(2);
    expect(traffic.body.applications).toHaveLength(2);
  });
});
