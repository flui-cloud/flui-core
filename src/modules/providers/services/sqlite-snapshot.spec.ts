jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  loadAllYaml: jest.fn(),
}));

import { load } from 'js-yaml';
import { VolumeExportService } from './volume-export.service';

describe('a copy of a volume holding a live SQLite', () => {
  const render = (name: string, args: Record<string, unknown>) =>
    load(
      (VolumeExportService.prototype as any)[name].call(
        Object.assign(Object.create(VolumeExportService.prototype), {}),
        {
          jobName: 'j',
          namespace: 'ns',
          sourcePvcName: 'data-ld-0',
          labels: { 'flui-app-id': 'a' },
          ...args,
        },
      ),
    ) as any;

  const s3 = {
    keyPrefix: 'exports/ld/1',
    s3: {
      bucket: 'b',
      endpoint: 'https://s3',
      region: 'fr-par',
      accessKeyId: 'k',
      secretAccessKey: 's',
    },
  };

  it('uploads online-backup snapshots and keeps the live files out', () => {
    const job = render('renderS3ExportJobManifest', {
      ...s3,
      consistentSqlite: true,
    });
    const pod = job.spec.template.spec;
    expect(pod.initContainers[0].name).toBe('sqlite-snapshot');
    const cmd = pod.containers[0].command.join(' ');
    expect(cmd).toContain('--filter-from /stage/excludes sync /src');
    expect(cmd).toContain('copy /stage/data');
    expect(pod.volumes.map((v: any) => v.name)).toEqual(['src', 'stage']);
    expect(pod.containers[0].volumeMounts[0].readOnly).toBe(true);
  });

  it('replaces the torn files on a local copy', () => {
    const job = render('renderTarCopyJobManifest', {
      destPvcName: 'copy',
      consistentSqlite: true,
    });
    const pod = job.spec.template.spec;
    expect(pod.initContainers[0].name).toBe('sqlite-snapshot');
    expect(pod.containers[0].command.join(' ')).toContain('/stage/remove');
  });

  it('leaves an ordinary copy exactly as it was', () => {
    const job = render('renderS3ExportJobManifest', s3);
    const pod = job.spec.template.spec;
    expect(pod.initContainers).toBeUndefined();
    expect(pod.volumes[0].persistentVolumeClaim.readOnly).toBe(true);
  });
});
