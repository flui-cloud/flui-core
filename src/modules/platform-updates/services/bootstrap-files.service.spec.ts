import { BootstrapFilesService } from './bootstrap-files.service';

describe('BootstrapFilesService.releaseFiles', () => {
  it('ignores an index entry that is not a plain manifest name', async () => {
    const files = new BootstrapFilesService();
    const fetched: string[] = [];
    jest.spyOn(files, 'text').mockImplementation(async (_ref, path) => {
      fetched.push(path);
      if (path === 'manifests/control/INDEX') {
        return [
          '09-flui-api',
          '../../scripts/k3s-master-init',
          'sub/dir',
          'a;b',
          '$(id)',
        ].join('\n');
      }
      if (path === 'manifests/common/INDEX') return '00a-traefik-config\n..';
      return 'kind: ConfigMap\n';
    });
    const release = await files.releaseFiles('ref', [], 'control');
    expect([...release.declared].sort()).toEqual([
      '00a-traefik-config.yaml',
      '09-flui-api.yaml',
    ]);
    expect([...release.files.keys()].sort()).toEqual([
      '00a-traefik-config.yaml',
      '09-flui-api.yaml',
    ]);
    expect(fetched.filter((p) => p.includes('..'))).toEqual([]);
  });
});
