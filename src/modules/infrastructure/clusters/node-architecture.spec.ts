jest.mock('@kubernetes/client-node', () => ({ CoreV1Api: class {} }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({
  __esModule: true,
  default: class {},
}));

import { ClustersService } from './clusters.service';
import { ClustersController } from './clusters.controller';
import { ByosNodeJoinService } from './services/byos-node-join.service';

const k8sNode = (
  name: string,
  architecture: string | undefined,
  spec: Record<string, unknown> = {},
) => ({
  metadata: { name },
  spec,
  status: { nodeInfo: architecture ? { architecture } : undefined },
});

function serviceListing(items: unknown[] | Error) {
  const service = Object.create(ClustersService.prototype) as ClustersService;
  const listNode = jest.fn(async () => {
    if (items instanceof Error) throw items;
    return { items };
  });
  Object.assign(service, {
    clusterRepository: {
      findOne: async () => ({ id: 'c1', kubeconfigEncrypted: 'sealed' }),
    },
    encryptionService: { decrypt: () => 'kubeconfig' },
    kubernetesService: {
      makeKubeConfig: () => ({ makeApiClient: () => ({ listNode }) }),
    },
  });
  return { service, listNode };
}

describe('what the cluster says about each node', () => {
  it('reads the architecture of every node from one listing, in Flui words', async () => {
    const { service, listNode } = serviceListing([
      k8sNode('demo-master', 'arm64'),
      k8sNode('demo-worker-1', 'amd64', { unschedulable: true }),
      k8sNode('demo-worker-2', undefined),
    ]);

    const facts = await service.liveNodeFacts('c1');

    expect(listNode).toHaveBeenCalledTimes(1);
    expect(facts?.get('demo-master')).toEqual({
      takesNewApps: true,
      architecture: 'arm',
    });
    expect(facts?.get('demo-worker-1')).toEqual({
      takesNewApps: false,
      architecture: 'x86',
    });
    expect(facts?.get('demo-worker-2')?.architecture).toBeNull();
  });

  it('answers null when the cluster cannot be asked', async () => {
    const { service } = serviceListing(new Error('unreachable'));
    await expect(service.liveNodeFacts('c1')).resolves.toBeNull();
  });
});

describe('GET /infrastructure/clusters/:id/nodes', () => {
  const row = (serverName: string) => ({
    id: `id-${serverName}`,
    serverName,
    nodeType: 'worker',
    ipAddress: '10.0.0.2',
    status: 'ready',
    providerResourceId: 'p1',
    provider: 'scaleway',
    region: 'fr-par-1',
    serverType: 'COPARM1-2C-8G',
    hourlyPriceEur: 0.04,
    createdAt: new Date(0),
    metadata: {},
  });

  function controller(
    live: Map<
      string,
      { takesNewApps: boolean; architecture: string | null }
    > | null,
  ) {
    const instance = Object.create(
      ClustersController.prototype,
    ) as ClustersController;
    Object.assign(instance, {
      clustersService: {
        getClusterNodes: async () => [row('demo-master'), row('gone')],
        liveNodeFacts: async () => live,
      },
    });
    return instance;
  }

  it('carries each node’s architecture beside takesNewApps', async () => {
    const nodes = await controller(
      new Map([['demo-master', { takesNewApps: true, architecture: 'arm' }]]),
    ).getClusterNodes('c1');

    expect(nodes[0]).toMatchObject({
      serverName: 'demo-master',
      takesNewApps: true,
      architecture: 'arm',
    });
    expect(nodes[1]).toMatchObject({ takesNewApps: null, architecture: null });
  });

  it('says null rather than guessing when the cluster could not be asked', async () => {
    const nodes = await controller(null).getClusterNodes('c1');
    expect(nodes.map((n) => n.architecture)).toEqual([null, null]);
  });
});

describe('the BYOS join script', () => {
  it('warns on an arm host before it installs anything, and carries on', () => {
    const service = Object.create(
      ByosNodeJoinService.prototype,
    ) as ByosNodeJoinService;
    const script = (
      service as unknown as { renderJoinScript(p: unknown): string }
    ).renderJoinScript({
      clusterId: 'c1',
      clusterName: 'demo',
      serverName: 'demo-worker-1',
      serverId: 's1',
      k3sToken: 't',
      k3sVersion: 'v1',
      masterIp: '10.0.0.1',
      caPublicKey: 'ssh-ed25519 AAAA',
      scriptsBaseUrl: 'https://scripts',
      rulesetB64: '',
      completeUrl: 'https://api/complete',
      curlInsecure: false,
    });

    const guard = script.indexOf('case "$(uname -m)" in');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(script.indexOf('k3s-worker-init.sh'));
    expect(script).toContain('x86_64 | amd64) ;;');
    expect(script).toContain(
      'echo "[Flui] Warning: Arm server: apps deployed from a repository are built for x86 and will not run on it. Catalog apps run normally." >&2',
    );
    const branches = script.slice(guard, script.indexOf('esac', guard));
    expect(branches).not.toContain('exit');
  });
});
