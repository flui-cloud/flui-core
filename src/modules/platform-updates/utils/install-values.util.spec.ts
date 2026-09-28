import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  imageTagSlots,
  parseInstallRecord,
  parseSecretsIndex,
  proveInstallValues,
  secretBearingFiles,
  tagForSlot,
} from './install-values.util';
import { sha256 } from './manifest-eligibility.util';
import { renderManifestFile } from './manifest-render.util';

const BOOTSTRAP = join(__dirname, '../../../../../bootstrap-scripts/manifests');
const haveTemplates = existsSync(BOOTSTRAP);
const ifTemplates = haveTemplates ? describe : describe.skip;
const template = (rel: string) => readFileSync(join(BOOTSTRAP, rel), 'utf8');

describe('reading the record the installer leaves', () => {
  it('reads every key and keeps an absent values list absent', () => {
    const record = parseInstallRecord({
      schema: '1',
      bootstrapRef: 'abc1234',
      releaseVersion: '',
      clusterType: 'control',
      k3sVersion: 'v1.35.4+k3s1',
      'secretRefs.json': '{"GRAFANA_PASSWORD":["a/b/c"]}',
      'transforms.json':
        '{"raw":["00a.yaml"],"ingressTls":{"secretName":"t","files":["09.yaml"]}}',
      'rendered.json': '{"09.yaml":"ff"}',
    });
    expect(record).toMatchObject({
      source: 'installer',
      bootstrapRef: 'abc1234',
      releaseVersion: null,
      values: undefined,
      secretRefs: { GRAFANA_PASSWORD: ['a/b/c'] },
      transforms: {
        raw: ['00a.yaml'],
        ingressTls: { secretName: 't', files: ['09.yaml'] },
      },
      rendered: { '09.yaml': 'ff' },
    });
  });

  it('survives a key that is not JSON, and knows a reconstruction by its label', () => {
    const record = parseInstallRecord(
      { schema: '1', 'values.json': '{not json' },
      { 'flui.cloud/install-values-source': 'reconstructed' },
    );
    expect(record?.values).toEqual({});
    expect(record?.source).toBe('reconstructed');
    expect(parseInstallRecord({})).toBeNull();
  });

  it('reads the secrets list, one location per line, several per variable', () => {
    const index = parseSecretsIndex(
      '# c\nA ns/s/k\nA ns2/s2/k2\n\nB bad-location\n',
    );
    expect(index.get('A')).toEqual(['ns/s/k', 'ns2/s2/k2']);
    expect(index.has('B')).toBe(false);
  });

  it('withholds every templated file when there is no secrets list', () => {
    const files = [
      { name: 'a.yaml', template: 'x: ${A}' },
      { name: 'b.yaml', template: 'x: 1' },
    ];
    expect(secretBearingFiles(files, null)).toEqual(['a.yaml']);
    expect(secretBearingFiles(files, new Set(['Z']))).toEqual([]);
  });
});

describe('the running image tag', () => {
  const slot = {
    variable: 'FLUI_API_IMAGE_TAG',
    kind: 'Deployment',
    name: 'flui-api',
    namespace: 'flui-system',
    container: 'flui-api',
    repository: 'ghcr.io/flui-cloud/core',
  };

  it('is read off the same repository, mirrored or not', () => {
    expect(tagForSlot(slot, 'ghcr.io/flui-cloud/core:0.13.0')).toBe('0.13.0');
    expect(tagForSlot(slot, 'mirror.local:5000/flui-cloud/core:1.0')).toBe(
      '1.0',
    );
    expect(tagForSlot(slot, 'ghcr.io/other/core:1.0')).toBeNull();
    expect(tagForSlot(slot, 'ghcr.io/flui-cloud/core')).toBeNull();
  });
});

describe('proving values file by file', () => {
  const tpl = 'a: "${X}"\nb: "${Y}"\n';

  it('keeps the candidate that reproduces the master, and only that one', () => {
    const master = renderManifestFile('f.yaml', tpl, { X: '2', Y: 'y' });
    const result = proveInstallValues({
      files: [
        {
          name: 'f.yaml',
          templates: [{ ref: 'r1', template: tpl }],
          masterSha: sha256(master),
          raw: false,
        },
      ],
      candidates: { X: ['1', '2'], Y: ['y'] },
      secretVariables: new Set(),
    });
    expect(result.values).toEqual({ X: '2', Y: 'y' });
    expect(result.files[0]).toMatchObject({ proven: true, ref: 'r1' });
  });

  it('proves nothing a changed file vouched for', () => {
    const result = proveInstallValues({
      files: [
        {
          name: 'f.yaml',
          templates: [{ ref: 'r1', template: tpl }],
          masterSha: sha256('edited by hand'),
          raw: false,
        },
      ],
      candidates: { X: ['1'], Y: ['y'] },
      secretVariables: new Set(),
    });
    expect(result.values).toEqual({});
    expect(result.unproven.X).toMatch(/^f\.yaml: /);
  });

  it('never renders a secret, so a file naming one stays unproven', () => {
    const result = proveInstallValues({
      files: [
        {
          name: 's.yaml',
          templates: [{ ref: 'r1', template: 'p: ${PW}' }],
          masterSha: sha256('p: x'),
          raw: false,
        },
      ],
      candidates: { PW: ['x'] },
      secretVariables: new Set(['PW']),
    });
    expect(result.files[0]).toMatchObject({ proven: false });
    expect(result.files[0].reason).toMatch(/a secret/);
  });

  it('drops a value two files disagree on', () => {
    const one = 'a: "${X}"\n';
    const two = 'b: "${X}"\n';
    const result = proveInstallValues({
      files: [
        {
          name: '1.yaml',
          templates: [{ ref: 'r', template: one }],
          masterSha: sha256('a: "p"\n'),
          raw: false,
        },
        {
          name: '2.yaml',
          templates: [{ ref: 'r', template: two }],
          masterSha: sha256('b: "q"\n'),
          raw: false,
        },
      ],
      candidates: { X: ['p', 'q'] },
      secretVariables: new Set(),
    });
    expect(result.values.X).toBeUndefined();
    expect(result.unproven.X).toMatch(/different values/);
  });

  it('proves a raw file by its bytes', () => {
    const raw = 'x: ${VOL_DIR}\n';
    const result = proveInstallValues({
      files: [
        {
          name: '01a.yaml',
          templates: [{ ref: 'r', template: raw }],
          masterSha: sha256(raw),
          raw: true,
        },
      ],
      candidates: {},
      secretVariables: new Set(),
    });
    expect(result.files[0].proven).toBe(true);
  });
});

ifTemplates('proving against the real templates', () => {
  it('recovers the values and the TLS binding of a nip.io control master', () => {
    const truth = {
      FLUI_BASE_DOMAIN: 'royal-gecko-72.1-2-3-4.nip.io',
      FLUI_API_IMAGE_TAG: '0.13.0-rc.8',
      FLUI_WEB_IMAGE_TAG: '0.13.0-rc.8',
      AUTH_MODE: 'local',
      OIDC_ISSUER: '',
      OIDC_AUDIENCE: '',
      CERTIFICATE_MODE: 'production',
      CLUSTER_ID: 'c-1',
      CLUSTER_NAME: 'control-cluster',
      CLUSTER_TYPE: 'control',
    };
    const tls = { secretName: 'flui-system-tls', files: ['09-flui-api.yaml'] };
    const names = [
      '09-flui-api.yaml',
      '10-flui-web.yaml',
      '12-flui-web-config.yaml',
      '04-vmagent-config.yaml',
    ];
    const files = names.map((name) => {
      const t = template(`control/${name}`);
      return {
        name,
        templates: [{ ref: 'r', template: t }],
        masterSha: sha256(
          renderManifestFile(name, t, truth, { ingressTls: tls }),
        ),
        raw: false,
      };
    });
    const candidates = Object.fromEntries(
      Object.entries(truth).map(([k, v]) => [k, ['wrong', v]]),
    );
    const result = proveInstallValues({
      files,
      candidates,
      ingressTls: { secretName: 'flui-system-tls' },
      secretVariables: new Set(),
    });
    expect(result.files.every((f) => f.proven)).toBe(true);
    expect(result.values).toEqual(truth);
    expect(result.ingressTlsFiles).toEqual(['09-flui-api.yaml']);
  });

  it('finds the image tag slots of the API and the dashboard', () => {
    expect(
      imageTagSlots(template('control/09-flui-api.yaml')).map((s) => [
        s.variable,
        s.name,
        s.container,
      ]),
    ).toEqual([['FLUI_API_IMAGE_TAG', 'flui-api', 'flui-api']]);
    expect(
      imageTagSlots(template('control/10-flui-web.yaml')).map(
        (s) => s.variable,
      ),
    ).toEqual(['FLUI_WEB_IMAGE_TAG']);
  });
});

const INSTALLER = join(BOOTSTRAP, '../scripts/k3s-master-init.sh');
const ifInstaller = existsSync(INSTALLER) ? describe : describe.skip;

ifInstaller('the installer writing a recorded value', () => {
  const run = (value: string): string => {
    const source = readFileSync(INSTALLER, 'utf8');
    const fn = /^json_string\(\) \{[\s\S]*?^\}/m.exec(source)?.[0] ?? '';
    const out = spawnSync(
      'bash',
      ['-c', `${fn}\njson_string "$1"`, '_', value],
      {
        encoding: 'utf8',
      },
    );
    return out.stdout;
  };

  it('writes JSON for any value, control characters included', () => {
    const value = 'a"b\\c\nd\te\rf\u0001g\u001fh\u001bi é';
    expect(JSON.parse(run(value))).toBe(value);
    expect(run('plain')).toBe('"plain"');
  });
});
