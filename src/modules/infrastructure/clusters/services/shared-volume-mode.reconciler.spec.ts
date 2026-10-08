jest.mock('@kubernetes/client-node', () => ({}));

import { SharedVolumeModeReconciler } from './shared-volume-mode.reconciler';
import {
  localPathConfigFor,
  observedVolumeConfig,
} from './shared-volume-mode.core';

const K3S_DEFAULT = JSON.stringify({
  nodePathMap: [
    {
      node: 'DEFAULT_PATH_FOR_NON_LISTED_NODES',
      paths: ['/var/lib/rancher/k3s/storage'],
    },
  ],
});

describe('which volume settings the provisioner holds', () => {
  it('recognises Flui’s two settings and K3s’ own', () => {
    expect(observedVolumeConfig(localPathConfigFor('shared'))).toBe('shared');
    expect(observedVolumeConfig(localPathConfigFor('pinned'))).toBe('pinned');
    expect(observedVolumeConfig(K3S_DEFAULT)).toBe('k3s-default');
    expect(observedVolumeConfig('{"nodePathMap":[]}')).toBe('custom');
    expect(observedVolumeConfig('not json')).toBe('custom');
  });
});

function setup(opts: {
  config?: string | null;
  workerSees?: boolean;
  workerReady?: boolean;
  volumeType?: string;
}) {
  const token = { value: '' };
  const kubernetes = {
    readConfigMapKey: jest
      .fn()
      .mockResolvedValue(
        opts.config === undefined ? localPathConfigFor('pinned') : opts.config,
      ),
    listIngressNodeStates: jest.fn().mockResolvedValue([
      { name: 'wc-master', ready: true },
      { name: 'wc-worker-1', ready: opts.workerReady ?? true },
    ]),
    runOnNode: jest
      .fn()
      .mockImplementation(
        async (_k: string, node: string, _d: string, script: string) => {
          if (node === 'wc-master') {
            token.value = /echo (\S+) >/.exec(script)![1];
            return '';
          }
          return opts.workerSees === false ? '' : `${token.value}\n`;
        },
      ),
    writeConfigMapKey: jest.fn().mockResolvedValue(undefined),
    restartWorkload: jest.fn().mockResolvedValue(undefined),
    getResource: jest.fn().mockResolvedValue({
      metadata: {
        name: 'local-path',
        annotations: { defaultVolumeType: opts.volumeType ?? 'local' },
      },
    }),
    mergePatchObject: jest.fn().mockResolvedValue(undefined),
  };
  const clusters = {
    findOne: jest.fn().mockResolvedValue({
      id: 'c1',
      name: 'wc',
      kubeconfigEncrypted: 'k',
      sharedStorageEnabled: true,
      metadata: {},
      nodes: [
        { serverName: 'wc-master', nodeType: 'master' },
        { serverName: 'wc-worker-1', nodeType: 'worker' },
      ],
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const reconciler = new SharedVolumeModeReconciler(
    clusters as never,
    kubernetes as never,
    { decrypt: (v: string) => v } as never,
  );
  return { reconciler, kubernetes, clusters };
}

describe('volumes usable from any node, once every node proves it sees the shared storage', () => {
  it('frees new volumes from their node when every node reads the token back', async () => {
    const { reconciler, kubernetes } = setup({});

    await expect(reconciler.reconcile('c1')).resolves.toEqual({
      state: 'set',
      mode: 'shared',
      nodesWithoutShare: [],
    });
    expect(kubernetes.writeConfigMapKey).toHaveBeenCalledWith(
      'k',
      'kube-system',
      'local-path-config',
      'config.json',
      localPathConfigFor('shared'),
    );
    expect(kubernetes.restartWorkload).toHaveBeenCalledWith(
      'k',
      'Deployment',
      'kube-system',
      'local-path-provisioner',
    );
  });

  it('keeps volumes on their node, and names the node, when one does not see it', async () => {
    const { reconciler, kubernetes, clusters } = setup({
      config: localPathConfigFor('shared'),
      workerSees: false,
    });

    await expect(reconciler.reconcile('c1')).resolves.toMatchObject({
      state: 'set',
      mode: 'pinned',
      nodesWithoutShare: ['wc-worker-1'],
    });
    expect(kubernetes.writeConfigMapKey).toHaveBeenCalledWith(
      'k',
      'kube-system',
      'local-path-config',
      'config.json',
      localPathConfigFor('pinned'),
    );
    expect(clusters.update).toHaveBeenCalledWith('c1', {
      metadata: expect.objectContaining({
        sharedVolumes: expect.objectContaining({
          nodesWithoutShare: ['wc-worker-1'],
        }),
      }),
    });
  });

  it('puts Flui’s settings back after K3s restored its own', async () => {
    const { reconciler, kubernetes } = setup({ config: K3S_DEFAULT });

    await reconciler.reconcile('c1');
    expect(kubernetes.writeConfigMapKey).toHaveBeenCalled();
  });

  it('leaves settings somebody changed by hand alone', async () => {
    const { reconciler, kubernetes } = setup({
      config: '{"nodePathMap":[{"node":"x","paths":["/data"]}]}',
    });

    await expect(reconciler.reconcile('c1')).resolves.toMatchObject({
      state: 'skipped',
    });
    expect(kubernetes.runOnNode).not.toHaveBeenCalled();
    expect(kubernetes.writeConfigMapKey).not.toHaveBeenCalled();
  });

  it('makes volumes of the kind shared mode can hold, which a local volume is not', async () => {
    const { reconciler, kubernetes } = setup({});

    await reconciler.reconcile('c1');
    expect(kubernetes.mergePatchObject).toHaveBeenCalledWith('k', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'local-path',
        annotations: { defaultVolumeType: 'hostPath' },
      },
    });
  });

  it('puts the kind back after K3s restored its own, even when the settings already match', async () => {
    const { reconciler, kubernetes } = setup({
      config: localPathConfigFor('shared'),
      volumeType: 'local',
    });

    await expect(reconciler.reconcile('c1')).resolves.toMatchObject({
      state: 'set',
      mode: 'shared',
    });
    expect(kubernetes.mergePatchObject).toHaveBeenCalled();
    expect(kubernetes.writeConfigMapKey).not.toHaveBeenCalled();
  });

  it('changes nothing when the setting already matches', async () => {
    const { reconciler, kubernetes } = setup({
      config: localPathConfigFor('shared'),
      volumeType: 'hostPath',
    });

    await expect(reconciler.reconcile('c1')).resolves.toMatchObject({
      state: 'unchanged',
      mode: 'shared',
    });
    expect(kubernetes.writeConfigMapKey).not.toHaveBeenCalled();
  });
});
