import { SandboxScope, findSandboxProjection } from './sandbox-projection';

const scope = (over: Partial<SandboxScope> = {}): SandboxScope => ({
  userId: 'guest-1',
  clusterId: 'own-cluster',
  projectIds: new Set<string>(),
  applicationIds: new Set<string>(),
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

  describe('the nodes under you', () => {
    const nodes = [
      {
        id: 'n1',
        serverName: 'flui-master',
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
