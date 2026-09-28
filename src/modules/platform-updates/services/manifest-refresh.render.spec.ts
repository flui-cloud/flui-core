jest.mock('@kubernetes/client-node', () => ({}));

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestRefreshService } from './manifest-refresh.service';
import { InstallValuesService } from './install-values.service';
import { MasterAccessService } from './master-access.service';
import { InstallStateService } from './install-state.service';
import { InstallSourcesService } from './install-sources.service';
import { BootstrapFilesService, ReleaseFile } from './bootstrap-files.service';
import { HeldFile, WITHHELD_BY_HISTORY } from './manifest-master.service';
import { parseSecretsIndex } from '../utils/install-values.util';
import { renderManifestFile } from '../utils/manifest-render.util';
import { sha256 } from '../utils/manifest-eligibility.util';

/**
 * The refresh end to end against the real templates, with the cluster and the
 * master replaced by fakes: which values it renders with, what it withholds,
 * which Secrets it creates, and what it would write.
 */
const BOOTSTRAP = join(__dirname, '../../../../../bootstrap-scripts/manifests');
const ifTemplates = existsSync(BOOTSTRAP) ? describe : describe.skip;
const read = (rel: string): string | null =>
  existsSync(join(BOOTSTRAP, rel))
    ? readFileSync(join(BOOTSTRAP, rel), 'utf8')
    : null;

const TRUTH = {
  FLUI_BASE_DOMAIN: 'royal-gecko-72.1-2-3-4.nip.io',
  FLUI_API_IMAGE_TAG: '0.13.0',
  FLUI_WEB_IMAGE_TAG: '0.13.0',
  AUTH_MODE: 'local',
  OIDC_ISSUER: '',
  OIDC_AUDIENCE: '',
  CERTIFICATE_MODE: 'production',
  CLUSTER_ID: 'c-1',
  CLUSTER_NAME: 'control-cluster',
  CLUSTER_TYPE: 'control',
};
const TLS = {
  secretName: 'flui-system-tls',
  files: ['09-flui-api.yaml', '10-flui-web.yaml'],
};
const TOKEN = 'webhook-token-value';

const OLD_ALERTMANAGER = (): string =>
  (read('control/04d-alertmanager.yaml') as string).replace(
    'credentials_file: /etc/alertmanager-secrets/token',
    'credentials: "${ALERTS_WEBHOOK_TOKEN}"',
  );

function fakeFiles(
  installed: Record<string, string> = {},
): BootstrapFilesService {
  const templatesFor = async (ref: string, names: string[]) =>
    names.flatMap((name): ReleaseFile[] => {
      if (ref === 'installed-ref' && name === '04d-alertmanager.yaml') {
        return [{ name, set: 'control', template: OLD_ALERTMANAGER() }];
      }
      if (ref === 'installed-ref' && installed[name] !== undefined) {
        return [{ name, set: 'control', template: installed[name] }];
      }
      for (const set of ['control', 'common'] as const) {
        const template = read(`${set}/${name}`);
        if (template !== null) return [{ name, set, template }];
      }
      return [];
    });
  return {
    secrets: async () => parseSecretsIndex(read('SECRETS') ?? ''),
    templatesFor,
    releaseFiles: async (ref: string) => {
      const lines = (set: string) =>
        (read(`${set}/INDEX`) ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
      const files = new Map<string, ReleaseFile>();
      for (const [set, names] of [
        ['control', lines('control')],
        ['common', lines('common')],
      ] as const) {
        for (const n of names) {
          const template = read(`${set}/${n}.yaml`);
          if (template !== null) {
            files.set(`${n}.yaml`, { name: `${n}.yaml`, set, template });
          }
        }
      }
      return {
        ref,
        indexed: true,
        declared: new Set(files.keys()),
        files,
      };
    },
  } as unknown as BootstrapFilesService;
}

/** Legacy templates that render secrets inline. */
function masterFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of [
    '09-flui-api.yaml',
    '10-flui-web.yaml',
    '12-flui-web-config.yaml',
    '04-vmagent-config.yaml',
    '02-postgres.yaml',
  ]) {
    out.set(
      name,
      renderManifestFile(name, read(`control/${name}`) as string, TRUTH, {
        ingressTls: TLS,
      }),
    );
  }
  out.set(
    '04d-alertmanager.yaml',
    (read('control/04d-alertmanager.yaml') as string).replace(
      'credentials_file: /etc/alertmanager-secrets/token',
      `credentials: "${TOKEN}"`,
    ),
  );
  out.set(
    '00-secrets.yaml',
    'apiVersion: v1\nkind: Secret\nmetadata:\n  name: flui-secrets\n',
  );
  return out;
}

function setup(options: {
  record: boolean;
  onDisk?: Record<string, string>;
  installed?: Record<string, string>;
  secretData?: Record<string, string>;
}) {
  const onDisk = masterFiles();
  for (const [name, content] of Object.entries(options.onDisk ?? {})) {
    onDisk.set(name, content);
  }
  const withheldAsked: Array<Iterable<string> | 'all'> = [];
  const master = {
    read: jest.fn(
      async (
        _kc: string,
        _node: string,
        withhold: Iterable<string> | 'all',
      ) => {
        withheldAsked.push(withhold);
        const hold =
          withhold === 'all'
            ? null
            : new Set([...withhold, ...WITHHELD_BY_HISTORY]);
        const held = new Map<string, HeldFile>();
        for (const [name, content] of onDisk) {
          const sha = sha256(content);
          if (/^kind:\s*Secret/m.test(content)) {
            held.set(name, { sha, carriesSecret: true });
          } else if (hold === null || hold.has(name)) {
            held.set(name, {
              sha,
              carriesSecret: false,
              withheld: true,
              declaresProvenance: true,
            });
          } else {
            held.set(name, { sha, carriesSecret: false, content });
          }
        }
        return held;
      },
    ),
    write: jest.fn(async (_kc: string, _n: string, _p: string, files: any[]) =>
      files.map((f) => f.name),
    ),
  };

  const created: any[] = [];
  const live: Record<string, any> = {
    'apps/v1/Deployment/flui-api': {
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'flui-api', image: 'ghcr.io/flui-cloud/core:0.14.0' },
            ],
          },
        },
      },
    },
    'apps/v1/Deployment/flui-web': {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'flui-web',
                image: 'ghcr.io/flui-cloud/dashboard:0.13.0',
              },
            ],
          },
        },
      },
    },
    'apps/v1/Deployment/alertmanager': {
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'alertmanager', image: 'prom/alertmanager:v0.27.0' },
            ],
          },
        },
      },
    },
  };
  if (options.record) {
    live['v1/ConfigMap/flui-install-values'] = {
      data: {
        schema: '1',
        bootstrapRef: 'installed-ref',
        'values.json': JSON.stringify(TRUTH),
        'transforms.json': JSON.stringify({ raw: [], ingressTls: TLS }),
        'rendered.json': '{}',
      },
    };
  }
  const kube = {
    readObject: jest.fn(
      async (_kc: string, apiVersion: string, kind: string, name: string) =>
        live[`${apiVersion}/${kind}/${name}`] ?? null,
    ),
    secretExists: jest.fn(
      async (_kc: string, name: string) => name === 'flui-secrets',
    ),
    readSecretData: jest.fn(async (_kc: string, name: string) =>
      name === 'flui-secrets'
        ? (options.secretData ?? {
            ALERTS_WEBHOOK_TOKEN: TOKEN,
            GRAFANA_ADMIN_PASSWORD: 'g',
          })
        : null,
    ),
    createObject: jest.fn(async (_kc: string, object: any) => {
      created.push(object);
    }),
    listCrdResources: jest.fn(async () => []),
  };
  const cluster = {
    id: 'c-1',
    kubeconfigEncrypted: 'enc',
    nodes: [{ nodeType: 'master', serverName: 'master-0' }],
  };
  const clusters = { findOne: async () => cluster } as never;
  const installValues = new InstallValuesService(
    new MasterAccessService(clusters, { decrypt: () => 'kubeconfig' } as never),
    new InstallStateService(kube as never, clusters),
    new InstallSourcesService(fakeFiles(options.installed), {
      getManifest: async () => ({ manifest: { releases: [] } }),
    } as never),
    master as never,
  );
  const service = new ManifestRefreshService(
    kube as never,
    master as never,
    {} as never,
    fakeFiles(options.installed),
    installValues,
  );
  return { service, master, kube, created, withheldAsked, installValues };
}

ifTemplates('a refresh that renders templated files', () => {
  it('renders with the proven record and the running tag, and never reads a secret-bearing body', async () => {
    const { service, master, withheldAsked } = setup({ record: true });
    const plan = await service.plan({});
    const by = Object.fromEntries(plan.entries.map((e) => [e.name, e]));

    expect(plan.valuesUnavailable).toBeUndefined();
    expect(by['09-flui-api.yaml'].action).toBe('replace');
    expect(by['09-flui-api.yaml'].renderedWith).toEqual([
      'FLUI_API_IMAGE_TAG',
      'FLUI_BASE_DOMAIN',
    ]);
    expect(by['10-flui-web.yaml'].action).toBe('unchanged');
    expect(by['12-flui-web-config.yaml'].action).toBe('unchanged');
    expect(by['04-vmagent-config.yaml'].action).toBe('unchanged');
    expect(by['00-secrets.yaml'].action).toBe('skip');

    expect(by['04d-alertmanager.yaml'].action).toBe('replace');
    expect(by['04d-alertmanager.yaml'].createsSecrets).toEqual([
      'flui-control/alertmanager-webhook',
    ]);
    expect(by['08-grafana.yaml'].action).toBe('add');
    expect(by['08-grafana.yaml'].createsSecrets).toEqual([
      'flui-control/grafana-admin',
    ]);

    expect(withheldAsked.every((w) => w === 'all')).toBe(true);
    const returned = await master.read.mock.results[0].value;
    expect(returned.get('04d-alertmanager.yaml').content).toBeUndefined();
  });

  it('writes the rendered file and creates the Secrets from where the values already live', async () => {
    const { service, master, created } = setup({ record: true });
    const { planId } = await service.plan({});
    const result = await service.apply({ planId });

    expect(
      created.map((o) => `${o.metadata.namespace}/${o.metadata.name}`),
    ).toEqual([
      'flui-control/alertmanager-webhook',
      'flui-control/grafana-admin',
    ]);
    expect(Buffer.from(created[0].data.token, 'base64').toString()).toBe(TOKEN);

    const files = master.write.mock.calls[0][3] as Array<{
      name: string;
      content: string;
    }>;
    const api = files.find((f) => f.name === '09-flui-api.yaml')?.content;
    expect(api).toContain('ghcr.io/flui-cloud/core:0.14.0');
    expect(api).toContain('secretName: flui-system-tls');
    expect(api).toContain('api.royal-gecko-72.1-2-3-4.nip.io');
    expect(
      files.find((f) => f.name === '04d-alertmanager.yaml')?.content,
    ).not.toContain(TOKEN);
    expect(result.wrote).toEqual(files.map((f) => f.name));
  });

  it('stays narrow without a record, and says how to get one', async () => {
    const { service } = setup({ record: false });
    const plan = await service.plan({});
    const api = plan.entries.find((e) => e.name === '09-flui-api.yaml');
    expect(plan.valuesUnavailable).toMatch(/no record/);
    expect(api?.action).toBe('skip');
    expect(api?.reason).toMatch(/supplies no values/);
    expect(
      plan.entries.find((e) => e.name === '04d-alertmanager.yaml')?.action,
    ).toBe('replace');
  });

  it('reconstructs a missing record from what the platform runs, proving file by file', async () => {
    const { kube } = setup({ record: false });
    const { master } = setup({ record: false });
    const env = process.env;
    process.env = {
      ...env,
      API_BASE_URL: `https://api.${TRUTH.FLUI_BASE_DOMAIN}`,
      AUTH_MODE: 'local',
      CLUSTER_NAME: TRUTH.CLUSTER_NAME,
    };
    try {
      const flui = { ...kube };
      (flui.readObject as jest.Mock).mockImplementation(
        async (_kc: string, apiVersion: string, kind: string, name: string) => {
          if (kind === 'Deployment' && name === 'flui-api') {
            return {
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        name: 'flui-api',
                        image: 'ghcr.io/flui-cloud/core:0.13.0',
                      },
                    ],
                  },
                },
              },
            };
          }
          if (kind === 'Deployment' && name === 'flui-web') {
            return {
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        name: 'flui-web',
                        image: 'ghcr.io/flui-cloud/dashboard:0.13.0',
                      },
                    ],
                  },
                },
              },
            };
          }
          return null;
        },
      );
      (flui as any).listCrdResources = jest.fn(async () => []);
      const clusters = {
        findOne: async () => ({
          id: 'c-1',
          name: 'control-cluster',
          kubeconfigEncrypted: 'enc',
          nodes: [{ nodeType: 'master', serverName: 'master-0' }],
        }),
      } as never;
      const values = new InstallValuesService(
        new MasterAccessService(clusters, {
          decrypt: () => 'kubeconfig',
        } as never),
        new InstallStateService(flui as never, clusters),
        new InstallSourcesService(fakeFiles(), {
          getManifest: async () => ({ manifest: { releases: [] } }),
        } as never),
        master as never,
      );
      const plan = await values.plan();
      const proven = plan.files.filter((f) => f.proven).map((f) => f.name);
      expect(proven).toEqual(
        expect.arrayContaining([
          '09-flui-api.yaml',
          '10-flui-web.yaml',
          '12-flui-web-config.yaml',
          '04-vmagent-config.yaml',
        ]),
      );
      expect(plan.values).toMatchObject(TRUTH);
      expect(plan.ingressTlsFiles).toEqual(TLS.files);
      expect(plan.willWrite).toBe(true);
      expect(master.read).toHaveBeenCalledWith('kubeconfig', 'master-0', 'all');

      const result = await values.apply(plan.planId);
      expect(result.written).toBe(true);
      const record = (flui.createObject as jest.Mock).mock.calls[0][1];
      expect(record.metadata).toMatchObject({
        name: 'flui-install-values',
        namespace: 'kube-system',
      });
      expect(JSON.parse(record.data['values.json'])).toMatchObject(TRUTH);
      expect(record.data['values.json']).not.toContain(TOKEN);
      await expect(values.apply('stale')).rejects.toThrow(/changed/);
    } finally {
      process.env = env;
    }
  });

  it('leaves a file changed by hand on the master alone unless told to overwrite it', async () => {
    const web = renderManifestFile(
      '10-flui-web.yaml',
      read('control/10-flui-web.yaml') as string,
      TRUTH,
      { ingressTls: TLS },
    );
    const { service } = setup({
      record: true,
      onDisk: { '10-flui-web.yaml': `${web}# tuned by hand\n` },
    });
    const plan = await service.plan({});
    const entry = plan.entries.find((e) => e.name === '10-flui-web.yaml');
    expect(entry?.action).toBe('skip');
    expect(entry?.reason).toMatch(/modified on this master/);

    const forced = await service.plan({ allowOverwriteModified: true });
    expect(
      forced.entries.find((e) => e.name === '10-flui-web.yaml')?.action,
    ).toBe('replace');
  });

  it('never reads back a file an earlier release rendered a password into', async () => {
    const oldApi = (read('control/09-flui-api.yaml') as string).replace(
      /\n$/,
      '\n# db: postgres://fluicloud:${POSTGRES_PASSWORD}@postgres\n',
    );
    const onMaster = renderManifestFile(
      '09-flui-api.yaml',
      oldApi,
      { ...TRUTH, POSTGRES_PASSWORD: 'hunter2' },
      { ingressTls: TLS },
    );
    const { service, installValues } = setup({
      record: true,
      onDisk: { '09-flui-api.yaml': onMaster },
      installed: { '09-flui-api.yaml': oldApi },
    });
    const access = await installValues.masterAccess();
    const proven = await installValues.readProven(access);
    expect(proven.files.get('09-flui-api.yaml')?.content).toBeUndefined();
    expect(proven.files.get('10-flui-web.yaml')?.content).toBeDefined();
    expect(proven.mayHoldSecret.has('09-flui-api.yaml')).toBe(true);

    const plan = await service.plan({});
    const entry = plan.entries.find((e) => e.name === '09-flui-api.yaml');
    expect(entry?.reason ?? '').not.toMatch(/modified on this master/);
    expect(JSON.stringify(plan)).not.toContain('hunter2');
  });

  it('does not promise a Secret it could only copy from a key that is not there', async () => {
    const { service } = setup({
      record: true,
      secretData: { GRAFANA_ADMIN_PASSWORD: 'g' },
    });
    const plan = await service.plan({});
    const entry = plan.entries.find((e) => e.name === '04d-alertmanager.yaml');
    expect(entry?.action).toBe('skip');
    expect(entry?.reason).toContain(
      'flui-system/flui-secrets/ALERTS_WEBHOOK_TOKEN',
    );
    expect(entry?.missingSecretKeys).toEqual([
      'flui-system/flui-secrets/ALERTS_WEBHOOK_TOKEN',
    ]);
  });
});
