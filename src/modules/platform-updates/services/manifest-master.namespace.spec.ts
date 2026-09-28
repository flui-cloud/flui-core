jest.mock('@kubernetes/client-node', () => ({}));

import { ManifestMasterService } from './manifest-master.service';
import { BootstrapFilesService } from './bootstrap-files.service';

function master(namespaces: string[]) {
  const applied: string[] = [];
  const kube = {
    readObject: jest.fn(
      async (_kc: string, _v: string, kind: string, name: string) =>
        kind === 'Namespace' && namespaces.includes(name) ? { name } : null,
    ),
    applyManifest: jest.fn(async (_kc: string, yaml: string) => {
      applied.push(yaml);
      return [];
    }),
    getResource: jest.fn(async () => ({ status: { succeeded: 1 } })),
    deleteResource: jest.fn(async () => undefined),
    makeKubeConfig: () => ({
      makeApiClient: () => ({
        listNamespacedPod: async () => ({
          items: [{ metadata: { name: 'p' } }],
        }),
      }),
    }),
    getPodLogs: jest.fn(async () => 'FILE vmagent.yaml abc plain\n'),
  };
  return { service: new ManifestMasterService(kube as never), kube, applied };
}

describe('where the manifest jobs run', () => {
  it('uses flui-local-storage where the cluster has it', async () => {
    const { service, applied, kube } = master(['flui-local-storage']);
    await service.read('kc', 'wk-master', 'all');
    expect(applied[0]).toContain('namespace: flui-local-storage');
    expect(kube.getPodLogs).toHaveBeenCalledWith(
      'kc',
      'p',
      'flui-local-storage',
    );
  });

  it('falls back to kube-system on a master without it', async () => {
    const { service, applied, kube } = master([]);
    const held = await service.read('kc', 'wk-master', 'all');
    expect(held.get('vmagent.yaml')?.sha).toBe('abc');
    expect(applied[0]).toContain('namespace: kube-system');
    expect(applied[0]).toContain('kubernetes.io/hostname: wk-master');
    expect(kube.deleteResource).toHaveBeenCalledWith(
      'kc',
      'Job',
      expect.stringMatching(/^flui-manifest-read-/),
      'kube-system',
    );
  });
});

describe('a release index with conditions', () => {
  it('reads the workload index and what each file requires', async () => {
    const files = new BootstrapFilesService();
    const texts: Record<string, string> = {
      'manifests/workload/INDEX':
        '# comment\nvmagent requires=DEPLOY_MONITORING_AGENT\nextra\n',
      'manifests/common/INDEX': '00a-traefik-config\n',
      'manifests/workload/vmagent.yaml': 'kind: A',
      'manifests/workload/extra.yaml': 'kind: B',
      'manifests/common/00a-traefik-config.yaml': 'kind: C',
    };
    jest
      .spyOn(files, 'text')
      .mockImplementation(async (_ref, path) => texts[path] ?? null);

    const release = await files.releaseFiles('ref', [], 'workload');
    expect(release.indexed).toBe(true);
    expect([...release.declared].sort()).toEqual([
      '00a-traefik-config.yaml',
      'extra.yaml',
      'vmagent.yaml',
    ]);
    expect(release.files.get('vmagent.yaml')?.set).toBe('workload');
    expect(release.files.get('00a-traefik-config.yaml')?.set).toBe('common');
    expect([...release.requires]).toEqual([
      ['vmagent.yaml', 'DEPLOY_MONITORING_AGENT'],
    ]);

    const control = await files.releaseFiles('ref', ['x.yaml'], 'control');
    expect(control.indexed).toBe(false);
    expect(control.files.has('vmagent.yaml')).toBe(false);
  });
});
