jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { KubernetesService } from './kubernetes.service';

const node = (architecture: string | undefined, unschedulable = false) => ({
  spec: { unschedulable },
  status: { nodeInfo: architecture ? { architecture } : undefined },
});

const withNodes = (items: unknown[]) => {
  const service: KubernetesService = Object.create(KubernetesService.prototype);
  (service as any).getKubeClient = () => ({
    coreApi: { listNode: async () => ({ items }) },
  });
  return service;
};

describe('KubernetesService.listSchedulableNodeArchitectures', () => {
  it('returns the distinct architectures of schedulable nodes', async () => {
    const service = withNodes([node('arm64'), node('arm64'), node('amd64')]);
    await expect(
      service.listSchedulableNodeArchitectures('kc'),
    ).resolves.toEqual(['arm64', 'amd64']);
  });

  it('ignores a reserved control-plane node when workers exist, and uses it when alone', async () => {
    const master = {
      spec: {
        taints: [
          {
            key: 'node-role.kubernetes.io/control-plane',
            effect: 'NoSchedule',
          },
        ],
      },
      status: { nodeInfo: { architecture: 'arm64' } },
    };
    await expect(
      withNodes([master, node('amd64')]).listSchedulableNodeArchitectures('kc'),
    ).resolves.toEqual(['amd64']);
    await expect(
      withNodes([master]).listSchedulableNodeArchitectures('kc'),
    ).resolves.toEqual(['arm64']);
  });

  it('leaves cordoned nodes out', async () => {
    const service = withNodes([node('arm64'), node('amd64', true)]);
    await expect(
      service.listSchedulableNodeArchitectures('kc'),
    ).resolves.toEqual(['arm64']);
  });

  it('counts every node when all of them are cordoned', async () => {
    const service = withNodes([node('arm64', true)]);
    await expect(
      service.listSchedulableNodeArchitectures('kc'),
    ).resolves.toEqual(['arm64']);
  });

  it('skips nodes that report no architecture', async () => {
    const service = withNodes([node(undefined)]);
    await expect(
      service.listSchedulableNodeArchitectures('kc'),
    ).resolves.toEqual([]);
  });
});
