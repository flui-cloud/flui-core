jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  loadAllYaml: jest.fn(),
}));

import { load } from 'js-yaml';
import { VolumeExportService } from './volume-export.service';
import { deriveCryptPasswords } from '../../backups/utils/rclone-crypt.util';

const keys = deriveCryptPasswords('destination-passphrase-for-tests');
const s3 = {
  bucket: 'b',
  endpoint: 'https://s3',
  region: 'fr-par',
  accessKeyId: 'ACCESS-KEY-LITERAL',
  secretAccessKey: 'SECRET-KEY-LITERAL',
};

function make() {
  const service = Object.create(
    VolumeExportService.prototype,
  ) as VolumeExportService;
  const applied: string[] = [];
  const order: string[] = [];
  (service as any).logger = { log: jest.fn(), warn: jest.fn() };
  (service as any).k8s = {
    getResource: jest.fn(async (_kc: string, kind: string) =>
      kind === 'Job'
        ? { status: { succeeded: 1 } }
        : { spec: { resources: { requests: { storage: '1Gi' } } } },
    ),
    applyManifest: jest.fn(async (_kc: string, m: string) => {
      applied.push(m);
      order.push(`apply:${/"kind":"Secret"|kind: Job/.exec(m)?.[0]}`);
    }),
    listResourcesByLabel: async () => [],
    deleteResource: jest.fn(async (_kc: string, kind: string) => {
      order.push(`delete:${kind}`);
    }),
  };
  return { service, applied, order };
}

const render = (name: string, args: Record<string, unknown>) =>
  (VolumeExportService.prototype as any)[name].call(
    Object.create(VolumeExportService.prototype),
    {
      jobName: 'j',
      namespace: 'ns',
      sourcePvcName: 'data',
      destPvcName: 'data-restored',
      labels: { 'flui-app-id': 'a' },
      keyPrefix: 'pre/exports/app/ts',
      s3,
      ...args,
    },
  ) as string;

describe('volume copies to object storage through rclone crypt', () => {
  it('writes an encrypted copy through flui_crypt, reading its keys from a Secret', () => {
    const yaml = render('renderS3ExportJobManifest', { encrypted: true });
    const pod = (load(yaml) as any).spec.template.spec;
    const script = pod.containers[0].command[2];

    expect(script).toContain('sync /src "flui_crypt:b/pre/exports/app/ts"');
    expect(script).toContain('rclone obscure -');
    expect(pod.containers[0].envFrom).toEqual([
      { secretRef: { name: 'j-s3' } },
    ]);
    expect(pod.containers[0].env).toBeUndefined();
    for (const literal of [
      s3.accessKeyId,
      s3.secretAccessKey,
      keys.password,
      keys.password2,
    ]) {
      expect(yaml).not.toContain(literal);
    }
  });

  it('keeps the SQLite variant on the same encrypted remote', () => {
    const yaml = render('renderS3ExportJobManifest', {
      encrypted: true,
      consistentSqlite: true,
    });
    const script = (load(yaml) as any).spec.template.spec.containers[0]
      .command[2];
    expect(script).toContain(
      '--filter-from /stage/excludes sync /src "flui_crypt:b/pre/exports/app/ts"',
    );
    expect(script).toContain(
      'copy /stage/data "flui_crypt:b/pre/exports/app/ts"',
    );
  });

  it('reads an encrypted copy back through crypt and a legacy one in plain', () => {
    const encrypted = (
      load(render('renderS3RestoreJobManifest', { encrypted: true })) as any
    ).spec.template.spec.containers[0].command[2];
    expect(encrypted).toContain(
      'rclone --metadata sync "flui_crypt:b/pre/exports/app/ts" /dst',
    );

    const legacy = (load(render('renderS3RestoreJobManifest', {})) as any).spec
      .template.spec.containers[0].command[2];
    expect(legacy).toContain(
      'rclone --metadata sync "flui:b/pre/exports/app/ts" /dst',
    );
    expect(legacy).not.toContain('obscure');
  });

  it('deletes through the plain remote, which sees both spellings', () => {
    const yaml = render('renderS3DeleteJobManifest', {});
    expect(yaml).toContain('rclone purge "flui:b/pre/exports/app/ts"');
    expect(yaml).not.toContain(s3.secretAccessKey);
  });

  it('holds the credentials and keys in a Secret that lives as long as the Job', async () => {
    const { service, applied, order } = make();

    const result = await service.createExport({
      sink: 's3-archive',
      kubeconfig: 'kc',
      namespace: 'ns',
      sourcePvcName: 'data',
      exportName: 'pre/exports/app/ts',
      keyPrefix: 'pre/exports/app/ts',
      labels: { 'flui-app-id': 'a' },
      ...s3,
      encryption: keys,
    });

    const secret = JSON.parse(applied[0]);
    expect(secret.kind).toBe('Secret');
    expect(secret.stringData).toMatchObject({
      RCLONE_CONFIG_FLUI_ACCESS_KEY_ID: s3.accessKeyId,
      RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY: s3.secretAccessKey,
      FLUI_CRYPT_PASSWORD: keys.password,
      FLUI_CRYPT_PASSWORD2: keys.password2,
    });
    expect(order[0]).toBe('apply:"kind":"Secret"');
    expect(order.at(-1)).toBe('delete:Secret');
    expect(result.encrypted).toBe(true);
  });

  it('removes the Secret even when the copy fails', async () => {
    const { service, order } = make();
    (service as any).k8s.getResource = jest.fn(
      async (_kc: string, kind: string) =>
        kind === 'Job'
          ? { status: { failed: 1 } }
          : { spec: { resources: { requests: { storage: '1Gi' } } } },
    );

    await expect(
      service.createExport({
        sink: 's3-archive',
        kubeconfig: 'kc',
        namespace: 'ns',
        sourcePvcName: 'data',
        exportName: 'x',
        keyPrefix: 'pre/exports/app/ts',
        labels: {},
        ...s3,
      }),
    ).rejects.toThrow(/failed/);
    expect(order.at(-1)).toBe('delete:Secret');
  });
});
