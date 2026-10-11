import { SandboxScope, findSandboxProjection } from './sandbox-projection';

const scope = (over: Partial<SandboxScope> = {}): SandboxScope => ({
  userId: 'guest-1',
  clusterId: 'own-cluster',
  projectIds: new Set<string>(),
  applicationIds: new Set<string>(),
  showcaseApplicationIds: new Set<string>(),
  ...over,
});

const project = (
  verb: string,
  path: string,
  body: unknown,
  s: SandboxScope,
  params: Record<string, string> = {},
) => {
  const rule = findSandboxProjection(verb, path);
  if (!rule) throw new Error(`no projection for ${verb} ${path}`);
  return rule.project(body, s, params);
};

describe('sandbox response projection', () => {
  /**
   * The workload list reaches the showcase application by a wider route than
   * `GET /showcase`, and carried `k8sNamespace` and `userId` with it — the
   * operator's namespace and account id, which `GET /showcase` omits on
   * purpose.
   */
  describe("somebody else's application in the list", () => {
    const own = { id: 'mine', slug: 'mine', k8sNamespace: 'user-guest-1' };
    const theirs = {
      id: 'showcase-1',
      slug: 'live-activity',
      k8sNamespace: 'user-operator',
      userId: 'operator-1',
    };

    it('takes the namespace and the owner off what is not the guest’s', () => {
      const out = project(
        'GET',
        '/clusters/own-cluster/applications',
        [theirs],
        scope({ applicationIds: new Set(['mine']) }),
      ) as Record<string, unknown>[];

      expect(out[0]).toEqual({ id: 'showcase-1', slug: 'live-activity' });
    });

    it('leaves the guest’s own application untouched', () => {
      const out = project(
        'GET',
        '/clusters/own-cluster/applications',
        [own],
        scope({ applicationIds: new Set(['mine']) }),
      ) as Record<string, unknown>[];

      expect(out[0]).toEqual(own);
    });

    it('reaches inside a group, or the grouped page answers what the flat one refuses', () => {
      const out = project(
        'GET',
        '/clusters/own-cluster/applications/grouped',
        [{ id: 'g1', name: 'Live activity', components: [theirs, own] }],
        scope({ applicationIds: new Set(['mine']) }),
      ) as Record<string, unknown>[];

      const components = out[0].components as Record<string, unknown>[];
      expect(components[0]).toEqual({
        id: 'showcase-1',
        slug: 'live-activity',
      });
      expect(components[1]).toEqual(own);
    });
  });

  describe('the cluster list', () => {
    const clusters = [
      {
        id: 'own-cluster',
        name: 'workload-1',
        provider: 'hetzner',
        region: 'fsn1',
        status: 'ready',
        clusterType: 'workload',
        nodeCount: 2,
        nodeSize: 'cx42',
        masterIpAddress: '10.0.0.1',
        vnetId: 'vnet-1',
        vnetName: 'net',
        grafanaPrometheusUid: 'prom-uid',
        grafanaLokiUid: 'loki-uid',
        createdAt: 'then',
        updatedAt: 'now',
        nodes: [
          {
            id: 'node-1',
            serverName: 'flui-worker-1',
            nodeType: 'worker',
            ipAddress: '10.0.0.2',
            status: 'ready',
            createdAt: 'then',
            vnetInfo: { vnetId: 'v', subnetId: 's', privateIp: '10.1.0.2' },
          },
        ],
      },
      { id: 'someone-elses', name: 'other', nodes: [] },
    ];

    it('keeps only the cluster the tenancy runs on', () => {
      const out = project(
        'GET',
        '/infrastructure/clusters',
        clusters,
        scope(),
      ) as Array<{ id: string }>;
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe('own-cluster');
    });

    it('keeps what shows the cluster is real', () => {
      const [out] = project(
        'GET',
        '/infrastructure/clusters',
        clusters,
        scope(),
      ) as Array<Record<string, unknown>>;
      expect(out).toMatchObject({
        name: 'workload-1',
        provider: 'hetzner',
        status: 'ready',
        nodeCount: 2,
      });
      expect(out.nodes).toEqual([
        {
          id: 'node-1',
          serverType: undefined,
          nodeType: 'worker',
          status: 'ready',
          createdAt: 'then',
        },
      ]);
    });

    it.each([
      'masterIpAddress',
      'nodeSize',
      'vnetId',
      'vnetName',
      'grafanaPrometheusUid',
      'grafanaLokiUid',
    ])('drops %s', (field) => {
      const [out] = project(
        'GET',
        '/infrastructure/clusters',
        clusters,
        scope(),
      ) as Array<Record<string, unknown>>;
      expect(out).not.toHaveProperty(field);
    });

    it.each(['serverName', 'ipAddress', 'vnetInfo'])(
      'drops %s from every node',
      (field) => {
        const [out] = project(
          'GET',
          '/infrastructure/clusters',
          clusters,
          scope(),
        ) as Array<{ nodes: Record<string, unknown>[] }>;
        expect(out.nodes[0]).not.toHaveProperty(field);
      },
    );

    it('returns nothing when the tenancy has no cluster of its own', () => {
      expect(
        project(
          'GET',
          '/infrastructure/clusters',
          clusters,
          scope({ clusterId: null }),
        ),
      ).toEqual([]);
    });
  });

  describe('the project list', () => {
    const projects = [
      { id: 'p-own', name: 'Sandbox' },
      { id: 'p-other', name: "Someone's roadmap" },
    ];

    it('keeps only projects holding an application the guest owns', () => {
      expect(
        project(
          'GET',
          '/projects',
          projects,
          scope({ projectIds: new Set(['p-own']) }),
        ),
      ).toEqual([{ id: 'p-own', name: 'Sandbox' }]);
    });

    it('is empty when the guest owns nothing in any project', () => {
      expect(project('GET', '/projects', projects, scope())).toEqual([]);
    });
  });

  describe('one cluster, read-only', () => {
    const own = {
      id: 'own-cluster',
      name: 'workload-1',
      masterIpAddress: '10.0.0.1',
      nodes: [
        {
          id: 'n1',
          serverName: 'flui-1',
          ipAddress: '10.0.0.2',
          nodeType: 'master',
          status: 'ready',
        },
      ],
    };

    it('returns the tenancy\u2019s own cluster, narrowed', () => {
      const out = project(
        'GET',
        '/infrastructure/clusters/own-cluster',
        own,
        scope(),
      ) as Record<string, unknown>;
      expect(out.name).toBe('workload-1');
      expect(out).not.toHaveProperty('masterIpAddress');
      expect(out.nodes).toEqual([
        { id: 'n1', nodeType: 'master', status: 'ready', createdAt: undefined },
      ]);
    });

    it('returns nothing for any other cluster', () => {
      expect(
        project(
          'GET',
          '/infrastructure/clusters/other',
          { ...own, id: 'other' },
          scope(),
        ),
      ).toBeNull();
    });
  });

  describe('endpoints and certificates', () => {
    const endpoints = [
      {
        id: 'e1',
        applicationId: 'app-mine',
        fqdn: 'mine.example.test',
        certificateStatus: 'issued',
        dnsRecordValue: '203.0.113.9',
        dnsRecordId: 'rec-1',
        errorMessage: 'internal detail',
      },
      { id: 'e2', applicationId: 'app-theirs', fqdn: 'theirs.example.test' },
    ];

    it('keeps only the endpoints of the guest\u2019s own applications', () => {
      const out = project(
        'GET',
        '/clusters/c1/endpoints',
        endpoints,
        scope({ applicationIds: new Set(['app-mine']) }),
      ) as Array<Record<string, unknown>>;
      expect(out).toHaveLength(1);
      expect(out[0].fqdn).toBe('mine.example.test');
      expect(out[0].certificateStatus).toBe('issued');
    });

    it.each(['dnsRecordValue', 'dnsRecordId', 'errorMessage'])(
      'drops %s',
      (field) => {
        const [out] = project(
          'GET',
          '/clusters/c1/endpoints',
          endpoints,
          scope({ applicationIds: new Set(['app-mine']) }),
        ) as Array<Record<string, unknown>>;
        expect(out).not.toHaveProperty(field);
      },
    );
  });

  describe('cluster metrics', () => {
    it('keeps the load and drops where the node lives', () => {
      const out = project(
        'GET',
        '/observability/clusters/c1/metrics',
        {
          cluster_id: 'c1',
          servers: [
            {
              instance: '10.0.1.5:9100',
              server_id: 'n1',
              cpu: { usage_percent: 4 },
            },
          ],
        },
        scope({ clusterId: 'c1' }),
        { clusterId: 'c1' },
      ) as { servers: Record<string, unknown>[] };

      expect(out.servers[0]).not.toHaveProperty('instance');
      expect(out.servers[0]).toMatchObject({
        server_id: 'n1',
        cpu: { usage_percent: 4 },
      });
    });
  });

  describe('the outbound ports of your cluster', () => {
    const policy = {
      open: false,
      ports: [{ port: 443, protocol: 'TCP' }],
      summary: 'Applications reach only port 443 outside the cluster.',
      namespaces: ['p-someone-else'],
    };

    it('keeps the rule and nothing about other spaces', () => {
      const out = project(
        'GET',
        '/infrastructure/clusters/own-cluster/egress-policy',
        policy,
        scope(),
        { id: 'own-cluster' },
      );
      expect(out).toEqual({
        open: false,
        ports: [{ port: 443, protocol: 'TCP' }],
        summary: 'Applications reach only port 443 outside the cluster.',
      });
    });

    it('answers nothing for another cluster', () => {
      expect(
        project(
          'GET',
          '/infrastructure/clusters/other/egress-policy',
          policy,
          scope(),
          { id: 'other' },
        ),
      ).toBeNull();
    });
  });

  describe('the nodes under you', () => {
    const nodes = [
      {
        id: 'n1',
        serverName: 'flui-master',
        serverType: 'cx23',
        nodeType: 'master',
        ipAddress: '10.0.0.1',
        status: 'ready',
        createdAt: 'then',
        providerResourceId: 'srv-9',
        metadata: { region: 'fsn1' },
      },
      {
        id: 'n2',
        serverName: 'flui-worker-1',
        nodeType: 'worker',
        ipAddress: '10.0.0.2',
        status: 'ready',
        createdAt: 'then',
      },
    ];

    it('shows how many there are and how they are', () => {
      const out = project(
        'GET',
        '/infrastructure/clusters/own-cluster/nodes',
        nodes,
        scope(),
        { id: 'own-cluster' },
      ) as Array<Record<string, unknown>>;

      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        id: 'n1',
        serverType: 'cx23',
        nodeType: 'master',
        status: 'ready',
        createdAt: 'then',
      });
    });

    it.each(['serverName', 'ipAddress', 'providerResourceId', 'metadata'])(
      'drops %s',
      (field) => {
        const [out] = project(
          'GET',
          '/infrastructure/clusters/own-cluster/nodes',
          nodes,
          scope(),
          { id: 'own-cluster' },
        ) as Array<Record<string, unknown>>;
        expect(out).not.toHaveProperty(field);
      },
    );

    // The cluster is in the path, so without the pin a guest could count the
    // nodes of any cluster on the instance simply by asking for its id.
    it('shows nothing for a cluster that is not the tenancy\u2019s', () => {
      expect(
        project('GET', '/infrastructure/clusters/other/nodes', nodes, scope(), {
          id: 'other',
        }),
      ).toEqual([]);
    });

    it('reports no servers for another cluster\u2019s metrics', () => {
      expect(
        project(
          'GET',
          '/observability/clusters/other/metrics',
          { cluster_id: 'other', servers: [{ instance: 'x', cpu: {} }] },
          scope(),
          { clusterId: 'other' },
        ),
      ).toEqual({ servers: [] });
    });
  });

  describe('an application’s metrics history', () => {
    const history = { app_id: 'x', namespace: 'p-showcase', data_points: [] };

    it('drops the namespace of an application that is not the guest’s', () => {
      expect(
        project(
          'GET',
          '/observability/applications/x/metrics/history',
          history,
          scope(),
          { appId: 'x' },
        ),
      ).toEqual({ app_id: 'x', data_points: [] });
    });

    it('leaves the guest’s own untouched', () => {
      expect(
        project(
          'GET',
          '/observability/applications/x/metrics/history',
          history,
          scope({ applicationIds: new Set(['x']) }),
          { appId: 'x' },
        ),
      ).toEqual(history);
    });
  });

  describe('endpoints on the cluster', () => {
    const endpoints = [
      { id: 'e1', applicationId: 'mine', fqdn: 'mine.example' },
      { id: 'e2', applicationId: 'showcase-app', fqdn: 'live.example' },
      { id: 'e3', applicationId: 'another-guest', fqdn: 'theirs.example' },
    ];

    it('shows the guest\u2019s own and the showcase\u2019s, never another guest\u2019s', () => {
      const out = project(
        'GET',
        '/clusters/own-cluster/endpoints',
        endpoints,
        scope({
          applicationIds: new Set(['mine']),
          showcaseApplicationIds: new Set(['showcase-app']),
        }),
        { clusterId: 'own-cluster' },
      ) as Array<{ id: string }>;
      expect(out.map((e) => e.id)).toEqual(['e1', 'e2']);
    });
  });

  describe('the cluster\u2019s health', () => {
    const health = {
      cluster_id: 'own-cluster',
      status: 'HEALTHY',
      summary: { total: 3, up: 3 },
      targets: [{ instance: '10.0.0.1:9100', up: true }],
      checked_at: 'now',
    };

    it('keeps the verdict and drops the addresses', () => {
      expect(
        project(
          'GET',
          '/observability/clusters/own-cluster/health',
          health,
          scope(),
          { clusterId: 'own-cluster' },
        ),
      ).toEqual({
        cluster_id: 'own-cluster',
        status: 'HEALTHY',
        summary: { total: 3, up: 3 },
        checked_at: 'now',
        targets: [],
      });
    });

    it('answers nothing for another cluster', () => {
      expect(
        project(
          'GET',
          '/observability/clusters/other/health',
          health,
          scope(),
          { clusterId: 'other' },
        ),
      ).toBeNull();
    });
  });

  describe('how busy the cluster is', () => {
    const status = {
      clusterId: 'own-cluster',
      warning: 'NONE',
      metrics: { cpuPct: 12, memoryPct: 40 },
      unschedulable: {
        count: 1,
        oldestWaitingSeconds: 30,
        largestRequest: {
          name: 'umami-db-0',
          namespace: 'sb-other-guest',
          cpuMillicores: 500,
          memoryMi: 512,
        },
        message: '0/2 nodes are available',
      },
    };

    it('keeps how many wait and drops what they are', () => {
      const out = project(
        'GET',
        '/infrastructure/clusters/own-cluster/autoscale/status',
        status,
        scope(),
        {
          id: 'own-cluster',
        },
      ) as { unschedulable: Record<string, unknown>; metrics: unknown };
      expect(out.unschedulable).toEqual({
        count: 1,
        oldestWaitingSeconds: 30,
        largestRequest: null,
        message: null,
      });
      expect(out.metrics).toEqual({ cpuPct: 12, memoryPct: 40 });
    });

    it('answers nothing for another cluster', () => {
      expect(
        project(
          'GET',
          '/infrastructure/clusters/other/autoscale/status',
          status,
          scope(),
          { id: 'other' },
        ),
      ).toBeNull();
    });
  });

  describe('the certificate issuers', () => {
    const issuers = [
      {
        name: 'letsencrypt-production',
        ready: true,
        email: 'ops@operator.example',
        solverType: 'combined',
        message: null,
      },
    ];

    it('keeps whether they are ready and drops the operator\u2019s address', () => {
      expect(
        project(
          'GET',
          '/clusters/own-cluster/dns-zone/issuers',
          issuers,
          scope(),
          { clusterId: 'own-cluster' },
        ),
      ).toEqual([
        {
          name: 'letsencrypt-production',
          ready: true,
          solverType: 'combined',
          message: null,
        },
      ]);
    });

    it('answers nothing for another cluster', () => {
      expect(
        project('GET', '/clusters/other/dns-zone/issuers', issuers, scope(), {
          clusterId: 'other',
        }),
      ).toEqual([]);
    });
  });

  describe('the home tiles', () => {
    const point = { timestamp: 't', nodes: 2, cpu: 9, memory: 40 };
    const fleet = {
      window: '3h',
      fleet: {
        clustersTotal: 2,
        clustersReporting: 2,
        nodesReporting: 4,
        current: { ...point, nodes: 4 },
        series: [{ ...point, nodes: 4 }],
      },
      clusters: [
        {
          clusterId: 'own-cluster',
          name: 'workload',
          metrics: 'reporting',
          nodesReporting: 2,
          current: point,
          series: [point],
        },
        {
          clusterId: 'control',
          name: 'control',
          metrics: 'reporting',
          nodesReporting: 2,
          current: point,
          series: [point],
        },
      ],
    };

    it('reads as a fleet of the tenancy’s own cluster', () => {
      const out = project('GET', '/fleet/metrics', fleet, scope()) as {
        fleet: Record<string, unknown>;
        clusters: Array<{ clusterId: string }>;
      };
      expect(out.clusters.map((c) => c.clusterId)).toEqual(['own-cluster']);
      expect(out.fleet).toEqual({
        clustersTotal: 1,
        clustersReporting: 1,
        nodesReporting: 2,
        current: point,
        series: [point],
      });
    });

    it('reads empty when the tenancy has no cluster', () => {
      const out = project(
        'GET',
        '/fleet/metrics',
        fleet,
        scope({ clusterId: null }),
      ) as { fleet: Record<string, unknown>; clusters: unknown[] };
      expect(out.clusters).toEqual([]);
      expect(out.fleet).toMatchObject({ clustersTotal: 0, current: null });
    });
  });

  describe('what carries no projection', () => {
    it.each([
      ['GET', '/applications/app-1'],
      ['GET', '/catalog'],
      ['POST', '/infrastructure/clusters'],
      ['GET', '/observability/applications/app-1/logs'],
    ])('leaves %s %s alone', (verb, path) => {
      expect(findSandboxProjection(verb, path)).toBeUndefined();
    });
  });
});
