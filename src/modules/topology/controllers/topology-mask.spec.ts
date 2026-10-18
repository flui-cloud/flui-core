jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  Metrics: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, from, toArray } from 'rxjs';
import { TopologyController } from './topology.controller';
import { MaskResponseInterceptor } from '../../mask/interceptors/mask-response.interceptor';
import { SensitivityRegistry } from '../../mask/sensitivity.registry';
import {
  AGENT_SURFACE_HEADER,
  agentSurfaceHeader,
} from '../../auth/utils/actor-surface';
import { TopologyEventType } from '../enums/topology.enums';

const NODE = 'prod-eu-worker-3';
const NAMESPACE = 'acme-shop';
const PROVIDER_ID = '48120331';
const HOST = 'shop.acme.io';

const server = {
  id: 'srv-1',
  clusterId: 'c1',
  nodeName: NODE,
  provider: 'hetzner',
  providerResourceId: PROVIDER_ID,
};

const events = [
  {
    type: TopologyEventType.SERVER_ADDED,
    data: { clusterId: 'c1', server },
  },
  {
    type: TopologyEventType.APP_DEPLOYED,
    data: { app: { id: 'a1', name: 'shop', namespace: NAMESPACE } },
  },
  {
    type: TopologyEventType.LINKS_CHANGED,
    data: { links: [{ id: 'l1', routeHost: HOST, label: 'HTTPS' }] },
  },
];

function context(
  handler: (...args: never[]) => unknown,
  headers: Record<string, string>,
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ headers, user: { userId: 'u1', iat: 1 } }),
    }),
  } as unknown as ExecutionContext;
}

const interceptor = new MaskResponseInterceptor(new SensitivityRegistry(), {
  get: () => 'test-mask-salt-secret',
} as never);

async function streamed(headers: Record<string, string>) {
  const next = { handle: () => from(events) } as CallHandler;
  return firstValueFrom(
    interceptor
      .intercept(context(TopologyController.prototype.stream, headers), next)
      .pipe(toArray()),
  ) as Promise<typeof events>;
}

describe('topology stream under mask mode', () => {
  it('replaces node names, namespaces, provider ids and route hosts while a screen is shared', async () => {
    const out = JSON.stringify(await streamed({ 'x-mask-mode': 'on' }));
    for (const real of [NODE, NAMESPACE, PROVIDER_ID, HOST]) {
      expect(out).not.toContain(real);
    }
    expect(out).toContain('"name":"shop"');
  });

  it('masks node names for an agent too', async () => {
    const out = await streamed({
      [AGENT_SURFACE_HEADER]: agentSurfaceHeader('mcp'),
    });
    const added = out[0].data as { server: typeof server };
    expect(added.server.nodeName).not.toBe(NODE);
  });

  it('leaves everything as it is with mask mode off', async () => {
    const out = JSON.stringify(await streamed({}));
    for (const real of [NODE, NAMESPACE, PROVIDER_ID, HOST]) {
      expect(out).toContain(real);
    }
  });
});

describe('topology snapshot under mask mode', () => {
  it('replaces the node name and provider id of every server', async () => {
    const body = {
      version: '2',
      clusters: [
        {
          id: 'c1',
          inbound: [
            {
              protocol: 'tcp',
              port: '443',
              description: 'HTTPS',
              fromAnywhere: true,
              sourceCount: 2,
            },
          ],
        },
      ],
      servers: [server],
      apps: [{ id: 'a1', namespace: NAMESPACE }],
      links: [],
    };
    const next = { handle: () => from([body]) } as CallHandler;
    const out = JSON.stringify(
      await firstValueFrom(
        interceptor.intercept(
          context(TopologyController.prototype.getTopology, {
            'x-mask-mode': 'on',
          }),
          next,
        ),
      ),
    );
    for (const real of [NODE, NAMESPACE, PROVIDER_ID]) {
      expect(out).not.toContain(real);
    }
    expect(out).toContain('"port":"443"');
  });
});
