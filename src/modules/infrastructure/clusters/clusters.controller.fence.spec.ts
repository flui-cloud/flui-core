/* eslint-disable sonarjs/assertions-in-tests --
   The assertion is supertest's own `.expect(status)`, which throws on a
   mismatch; the rule only recognises a global `expect()`. */

// Same reason as `resource-fence.spec.ts`: the controller's import graph reaches
// ESM-only packages ts-jest cannot transform, and this suite touches none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({
  __esModule: true,
  default: class {},
}));

import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import { ClustersController } from './clusters.controller';
import { ClustersService } from './clusters.service';
import { ClusterBillingService } from './services/cluster-billing.service';
import { ClusterAutoscaleService } from './services/cluster-autoscale.service';
import { ClusterVNetService } from './services/cluster-vnet.service';
import { ClusterScalingService } from './services/cluster-scaling.service';
import { ClusterStorageService } from './services/cluster-storage.service';
import { ClusterCapacityService } from './services/cluster-capacity.service';
import { ClusterNodeScalingService } from './services/cluster-node-scaling.service';
import { OrphanVolumesService } from './services/orphan-volumes.service';
import { ByosNodeJoinService } from './services/byos-node-join.service';
import { ByosVNetService } from './services/byos-vnet.service';
import { FirewallsService } from '../firewalls/services/firewalls.service';
import { KubernetesService } from '../shared/services/kubernetes.service';
import { GrafanaDatasourceService } from '../../grafana/services/grafana-datasource.service';
import { ResourceProfilesService } from '../../images/services/resource-profiles.service';
import { SectionAccessGuard } from '../../iam/guards/section-access.guard';
import { PolicyEngineService } from '../../iam/services/policy-engine.service';
import { POLICY_ENGINE } from '../../iam/interfaces/policy-engine.interface';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IamGroupEntity } from '../../iam/entities/iam-group.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';

/**
 * Facts about this controller, each worth a regression test:
 *
 * 1. **there is no kubeconfig route.** A kubeconfig is the key to the whole
 *    cluster and nobody downloads it — the router itself must not know the path;
 * 2. **the deploy wizard's reads stay open to an operator.** They are why the
 *    section gate sits on each route instead of on the class, so a class-level
 *    decorator added later would show up here as a 403;
 * 3. **the reads no caller needs are gated, and gated selectively.** Each one is
 *    asserted twice — refused to an operator *and* answered to someone holding the
 *    section — because a gate that refuses everybody is indistinguishable here
 *    from a route that has been broken;
 * 4. **there is no second inventory route.** Adoption's inventory lives on
 *    `/adoption/inventory` behind its own token guard; the copy that used to sit
 *    here had no caller and read metadata keys nothing writes;
 * 5. **the two autoscale reads carry the `clusters` section.** Decision 18
 *    expected an `operator` to keep them, on the premise that the rung above the
 *    viewer holds global `cluster:read`. For a while it did not — the ladder had
 *    drifted, and `viewer` carried a permission the step above it lacked — so
 *    the conversion closed them to that rung too. The ladder is cumulative
 *    again, so the premise is true and the reads are open to an `operator`.
 *    What still closes them is holding no *global* grant at all: a principal
 *    scoped to one application fails the section, and the dashboard half stays
 *    non-optional for exactly that person — the home pulse runs for every
 *    authenticated caller and must ask `canSee('clusters')` before calling.
 *    Pinned from both sides below.
 */

const CLUSTER = 'cluster-1';

const OPERATOR: AuthenticatedUser = {
  userId: 'user-operator',
  email: 'operator@flui.cloud',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

/**
 * Holds `cluster:manage` at global scope, which is what opens both the
 * `infrastructure` and the `firewall` sections. Still not an admin: the point is
 * that the gate is a section, not the boolean.
 */
const MAINTAINER: AuthenticatedUser = {
  userId: 'user-maintainer',
  email: 'maintainer@flui.cloud',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

/**
 * Scoped to a single application, which is what an application-scoped API key
 * looks like to the policy engine. Carries `app:*` and *no* global
 * `cluster:read`, so it fails the `clusters` section — and since the ladder was
 * repaired it is the *only* built-in shape that does. That is what makes it the
 * one worth pinning: a gate that no ordinary role trips is a gate nobody
 * notices breaking.
 */
const APP_SCOPED: AuthenticatedUser = {
  userId: 'user-app-scoped',
  email: 'app-scoped@flui.cloud',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

const globalBinding = (principalRef: string, role: string) => ({
  principalType: 'user',
  principalRef,
  role,
  scopeType: 'global',
  scopeRef: null,
  selector: null,
});

// Keyed by email, because that is what a `user` binding is matched on
// (`PolicyEngineService.findBindingsFor` looks up `principal.email`).
const BINDINGS: Record<string, unknown[]> = {
  [OPERATOR.email]: [globalBinding(OPERATOR.email, 'operator')],
  [MAINTAINER.email]: [globalBinding(MAINTAINER.email, 'maintainer')],
  [APP_SCOPED.email]: [
    {
      principalType: 'user',
      principalRef: APP_SCOPED.email,
      role: 'operator',
      scopeType: 'application',
      scopeRef: 'app-1',
      selector: null,
    },
  ],
};

describe('clusters controller — the fence around the cluster key', () => {
  let app: INestApplication;
  let currentUser: AuthenticatedUser = OPERATOR;

  beforeAll(async () => {
    const bindingsRepo = {
      createQueryBuilder: () => {
        const qb: Record<string, unknown> = {};
        const chain = () => qb;
        qb.where = chain;
        qb.orWhere = chain;
        qb.getMany = async () => BINDINGS[currentUser.email] ?? [];
        return qb;
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ClustersController],
      providers: [
        { provide: APP_GUARD, useClass: SectionAccessGuard },
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
          provide: ClustersService,
          useValue: {
            listClusters: async () => [{ id: CLUSTER, name: 'control' }],
            getClusterNodes: async () => [
              {
                id: 'node-1',
                serverName: 'control-master',
                nodeType: 'master',
                ipAddress: '10.0.0.1',
              },
            ],
            checkResourceAvailability: async () => ({ available: true }),
            getBuildResources: async () => ({ status: 'ok' }),
          },
        },
        {
          provide: FirewallsService,
          useValue: {
            getFirewallByClusterId: async () => ({
              id: 'fw-1',
              name: 'control',
              provider: 'hetzner',
              rules: [],
              appliedToServerIds: [],
              labels: {},
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          },
        },
        { provide: GrafanaDatasourceService, useValue: {} },
        { provide: ClusterBillingService, useValue: {} },
        { provide: ResourceProfilesService, useValue: {} },
        { provide: KubernetesService, useValue: {} },
        {
          provide: ClusterAutoscaleService,
          useValue: {
            getDefaults: () => ({ cpuThreshold: 80 }),
            getStatus: async () => ({ warning: 'NONE' }),
          },
        },
        { provide: ClusterVNetService, useValue: {} },
        { provide: ClusterScalingService, useValue: {} },
        { provide: ClusterStorageService, useValue: {} },
        {
          provide: ClusterCapacityService,
          useValue: { getPlan: async () => ({ candidates: [] }) },
        },
        {
          provide: ClusterNodeScalingService,
          useValue: { previewScaleNode: async () => ({ downtimeMinutes: 4 }) },
        },
        {
          provide: OrphanVolumesService,
          useValue: { scan: async () => [] },
        },
        { provide: ByosNodeJoinService, useValue: {} },
        { provide: ByosVNetService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(
      (req: { user: AuthenticatedUser }, _res: unknown, next: () => void) => {
        req.user = currentUser;
        next();
      },
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentUser = OPERATOR;
  });

  const http = () => request(app.getHttpServer());

  it('has no route that hands out a kubeconfig', async () => {
    const res = await http()
      .get(`/infrastructure/clusters/${CLUSTER}/kubeconfig`)
      .expect(404);
    expect(res.body.message).toContain('Cannot GET');
  });

  it('still answers the reads the deploy wizard makes to an operator', async () => {
    await http().get('/infrastructure/clusters').expect(200);
    await http().get(`/infrastructure/clusters/${CLUSTER}/nodes`).expect(200);
    await http()
      .get(`/infrastructure/clusters/${CLUSTER}/resource-availability`)
      .expect(200);
  });

  it('keeps the writes behind the infrastructure section', async () => {
    const res = await http()
      .post(`/infrastructure/clusters/${CLUSTER}/workers`)
      .send({ count: 1 })
      .expect(403);
    expect(res.body.message).toContain('infrastructure');
  });

  /**
   * The reads that had no caller. `:id/firewall` carries `firewall` rather than
   * `infrastructure` because what it returns is a firewall — the same object its
   * twin `GET /firewalls/cluster/:id` returns from behind that very section.
   * Both sections are opened by `cluster:manage` at global scope today, so the
   * choice costs nobody access; it decides which way this route moves if the two
   * sections ever stop being gated by the same permission.
   */
  const GATED: ReadonlyArray<[string, string]> = [
    ['/infrastructure/clusters/orphan-volumes', 'infrastructure'],
    [`/infrastructure/clusters/${CLUSTER}/capacity-plan`, 'infrastructure'],
    [
      `/infrastructure/clusters/${CLUSTER}/nodes/node-1/scale/preview`,
      'infrastructure',
    ],
    [`/infrastructure/clusters/${CLUSTER}/build-resources`, 'infrastructure'],
    [`/infrastructure/clusters/${CLUSTER}/firewall`, 'firewall'],
  ];

  it.each(GATED)('refuses %s to an operator', async (path, section) => {
    const res = await http().get(path).expect(403);
    expect(res.body.message).toContain(section);
  });

  it.each(GATED)('answers %s to whoever holds the section', async (path) => {
    currentUser = MAINTAINER;
    await http().get(path).expect(200);
  });

  it('has no second inventory route', async () => {
    const res = await http()
      .get(`/infrastructure/clusters/${CLUSTER}/inventory`)
      .expect(404);
    expect(res.body.message).toContain('Cannot GET');
  });

  /**
   * The two autoscale reads now carry `clusters`. The gate is global
   * `cluster:read`, which every rung of the ladder holds — so watching an
   * ordinary role alone would stay green forever and go on claiming to guard
   * something it no longer guards. The pair below watches the boundary the gate
   * actually draws: a global grant on one side, an application-scoped one on
   * the other.
   *
   * The dashboard calls both from `cluster-autoscale.service.ts` — a
   * hand-written HttpClient service, invisible to a search by generated method
   * name — and one of the call sites is the home pulse, which now asks
   * `canSee('clusters')` first instead of swallowing a 403.
   */
  const AUTOSCALE_READS = [
    '/infrastructure/clusters/autoscale/defaults',
    `/infrastructure/clusters/${CLUSTER}/autoscale/status`,
  ];

  it.each(AUTOSCALE_READS)(
    'answers %s to whoever holds global cluster:read',
    async (path) => {
      currentUser = MAINTAINER;
      await http().get(path).expect(200);
    },
  );

  it.each(AUTOSCALE_READS)(
    'refuses %s to a principal scoped to one application',
    async (path) => {
      currentUser = APP_SCOPED;
      const res = await http().get(path).expect(403);
      expect(res.body.message).toContain('clusters');
    },
  );

  /**
   * And the half decision 18 *did* expect, restored.
   *
   * It was false for as long as the rung above the viewer lacked `cluster:read`:
   * the section closed these two to the most common non-admin role on the
   * instance, the one whose browser opens the home pulse. The ladder now
   * guarantees an `operator` holds everything a `viewer` holds, so the premise
   * that reading was written against is true and this is the assertion that
   * says so. It is the mirror of the one above it: same routes, opposite
   * answer, and the difference is whether the grant is global.
   */
  it.each(AUTOSCALE_READS)('answers %s to an operator', async (path) => {
    await http().get(path).expect(200);
  });
});
