jest.mock('@kubernetes/client-node', () => ({}));

import { ConflictException } from '@nestjs/common';
import { AppManagementService } from './app-management.service';

type Internals = Record<string, jest.Mock>;

const active = {
  engine: 'cnpg',
  cluster: 'orders-db-ha',
  durability: 'quorum',
  instances: 3,
  state: 'active',
  since: '2026-11-07T18:00:00Z',
};

function build(databaseHa: object | null) {
  const kubernetes = {
    readObject: jest.fn().mockResolvedValue({
      spec: {
        resources: {
          requests: { cpu: '500m', memory: '1024Mi' },
          limits: { memory: '1024Mi' },
        },
      },
    }),
    mergePatchObject: jest.fn().mockResolvedValue(undefined),
    patchWorkloadContainerResources: jest.fn(),
    scaleWorkload: jest.fn(),
    restartWorkload: jest.fn(),
  };
  const applications = {
    update: jest.fn(),
    findById: jest.fn().mockResolvedValue({ id: 'a1', replicas: 1 }),
    updateStatus: jest.fn(),
  };
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
    app: {
      id: 'a1',
      slug: 'orders-db',
      k8sNamespace: 'ns',
      status: 'running',
      replicas: 1,
      resources: {},
      databaseHa,
    },
    kubeconfig: 'kc',
  });
  internals.getWorkloadOrThrow = jest.fn();
  internals.watchRollout = jest.fn();
  internals.buildRuntimeResponse = jest.fn().mockResolvedValue({});
  return { service, kubernetes, applications, revisions, internals };
}

describe('AppManagementService on a highly available database', () => {
  it('gives the new resources to its cluster, keeping what was not asked to change', async () => {
    const { service, kubernetes, internals, revisions } = build(active);

    await service.updateResources('a1', {
      requests: { memory: '2Gi' },
      limits: { memory: '2Gi' },
    });

    expect(kubernetes.mergePatchObject).toHaveBeenCalledWith('kc', {
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: { name: 'orders-db-ha', namespace: 'ns' },
      spec: {
        resources: {
          requests: { cpu: '500m', memory: '2Gi' },
          limits: { memory: '2Gi' },
        },
      },
    });
    expect(internals.getWorkloadOrThrow).not.toHaveBeenCalled();
    expect(kubernetes.patchWorkloadContainerResources).not.toHaveBeenCalled();
    expect(revisions.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: expect.anything() }),
    );
  });

  it('restarts its instances through the cluster, one at a time', async () => {
    const { service, kubernetes } = build(active);

    await service.restartDeployment('a1');

    const patch = kubernetes.mergePatchObject.mock.calls[0][1];
    expect(patch.metadata.name).toBe('orders-db-ha');
    expect(
      patch.metadata.annotations['kubectl.kubernetes.io/restartedAt'],
    ).toEqual(expect.any(String));
    expect(kubernetes.restartWorkload).not.toHaveBeenCalled();
  });

  it('refuses to change its copies, or to stop or start it', async () => {
    const { service, kubernetes } = build(active);

    await expect(service.updateReplicas('a1', { replicas: 2 })).rejects.toThrow(
      ConflictException,
    );
    await expect(service.stop('a1')).rejects.toThrow(
      'Flui keeps its 3 instances across three locations',
    );
    expect(kubernetes.scaleWorkload).not.toHaveBeenCalled();
  });

  it('waits for the move to end before any change', async () => {
    const { service, kubernetes } = build({ ...active, state: 'copying' });

    await expect(
      service.updateResources('a1', { requests: { cpu: '1' } }),
    ).rejects.toThrow('being made highly available');
    await expect(service.restartDeployment('a1')).rejects.toThrow(
      ConflictException,
    );
    expect(kubernetes.mergePatchObject).not.toHaveBeenCalled();
  });
});
