jest.mock('@kubernetes/client-node', () => ({}));
import { BadRequestException } from '@nestjs/common';
import { AppManagementService } from './app-management.service';

type Internals = {
  resolveAppAndKubeconfig: jest.Mock;
  getWorkloadOrThrow: jest.Mock;
  watchRollout: jest.Mock;
  buildRuntimeResponse: jest.Mock;
};

function build(resources: object) {
  const kubernetes = { patchWorkloadContainerResources: jest.fn() };
  const applications = { update: jest.fn() };
  const revisions = { createAuditEvent: jest.fn() };
  const service = new AppManagementService(
    {} as never,
    applications as never,
    revisions as never,
    {} as never,
    kubernetes as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const internals = service as unknown as Internals;
  internals.resolveAppAndKubeconfig = jest.fn().mockResolvedValue({
    app: { id: 'a1', k8sNamespace: 'ns', resources: {} },
    kubeconfig: 'kc',
  });
  internals.getWorkloadOrThrow = jest.fn().mockResolvedValue({
    kind: 'Deployment',
    name: 'web',
    resource: {
      spec: {
        template: { spec: { containers: [{ name: 'app', resources }] } },
      },
    },
  });
  internals.watchRollout = jest.fn();
  internals.buildRuntimeResponse = jest.fn().mockResolvedValue({});
  return { service, kubernetes, applications };
}

describe('AppManagementService.updateResources', () => {
  it('writes whole Mi and millicores, whatever the caller sent', async () => {
    const { service, kubernetes, applications } = build({
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '2426656522240m' },
    });

    await service.updateResources('a1', {
      requests: { memory: '1.5Gi' },
      limits: { cpu: '1.6', memory: '2.26Gi' },
    });

    expect(kubernetes.patchWorkloadContainerResources).toHaveBeenCalledWith(
      'kc',
      'Deployment',
      'ns',
      'web',
      'app',
      {
        requests: { cpu: '100m', memory: '1536Mi' },
        limits: { cpu: '1600m', memory: '2315Mi' },
      },
    );
    expect(applications.update).toHaveBeenCalledWith('a1', {
      resources: {
        cpu: { request: undefined, limit: '1600m' },
        memory: { request: '1536Mi', limit: '2315Mi' },
      },
    });
  });

  it('heals a fractional value already on the cluster when another field changes', async () => {
    const { service, kubernetes } = build({
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '2426656522240m' },
    });

    await service.updateResources('a1', { requests: { cpu: '200m' } });

    const written = kubernetes.patchWorkloadContainerResources.mock.calls[0][5];
    expect(written.limits.memory).toBe('2315Mi');
  });

  it('refuses a limit below its request and writes nothing', async () => {
    const { service, kubernetes } = build({
      requests: { cpu: '100m', memory: '1Gi' },
      limits: { cpu: '500m', memory: '2Gi' },
    });

    await expect(
      service.updateResources('a1', { limits: { memory: '512Mi' } }),
    ).rejects.toThrow(BadRequestException);
    expect(kubernetes.patchWorkloadContainerResources).not.toHaveBeenCalled();
  });

  it('refuses what is not a quantity', async () => {
    const { service } = build({});
    await expect(
      service.updateResources('a1', { requests: { memory: 'a lot' } }),
    ).rejects.toThrow('is not a memory quantity');
  });
});

describe('replicas waiting for a node', () => {
  const pending = {
    metadata: { name: 'probe-x' },
    spec: {
      containers: [{ resources: { requests: { cpu: '50m', memory: '3Gi' } } }],
    },
    status: {
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: '0/1 nodes are available: 1 Insufficient memory.',
        },
      ],
    },
  };

  function withScaling(
    purchase: unknown,
    sentence = 'It does not fit on the nodes already there. The group is manual: it would propose a cpx22 in fsn1 (€19.49 a month) and buy nothing until a person does.',
  ) {
    const kubernetes = {
      listPodsByLabel: jest
        .fn()
        .mockResolvedValue([
          pending,
          { metadata: { name: 'ok' }, status: { phase: 'Running' } },
        ]),
      parseCpu: (v: string) =>
        v.endsWith('m') ? Number.parseInt(v, 10) : Number(v) * 1000,
      parseMemory: (v: string) =>
        v.endsWith('Gi') ? Number.parseFloat(v) * 1024 : Number.parseInt(v, 10),
    };
    const moduleRef = {
      get: (token: { name: string }) =>
        token.name === 'ScalingGroupService'
          ? { listForCluster: jest.fn().mockResolvedValue([{ purchase }]) }
          : {
              whatIf: jest
                .fn()
                .mockResolvedValue({ verdict: 'proposes', sentence }),
            },
    };
    const service = new AppManagementService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      kubernetes as never,
      {} as never,
      {} as never,
      {} as never,
      moduleRef as never,
    );
    return (
      service as unknown as {
        roomWait: (
          a: unknown,
          k: string,
          d: number,
          r: number,
        ) => Promise<{
          replicas: number;
          says: string;
          verdict: string;
        } | null>;
      }
    ).roomWait.bind(service);
  }

  const app = { id: 'a1', clusterId: 'c1', k8sNamespace: 'ns' };

  it('says how many wait and what scaling does about it', async () => {
    const wait = await withScaling(null)(app, 'kc', 4, 3);
    expect(wait).toEqual({
      replicas: 1,
      verdict: 'proposes',
      says: '4 requested · 3 running · 1 waiting for a new node — The group is manual: it would propose a cpx22 in fsn1 (€19.49 a month) and buy nothing until a person does.',
    });
  });

  it('names the machine already on its way', async () => {
    const wait = await withScaling({
      state: 'buying',
      shape: 'cx33',
      region: 'fsn1',
      operation: { progress: 53 },
    })(app, 'kc', 2, 1);
    expect(wait?.says).toBe(
      '2 requested · 1 running · 1 waiting for a new node — cx33 in fsn1 is on its way (53%).',
    );
  });
});
