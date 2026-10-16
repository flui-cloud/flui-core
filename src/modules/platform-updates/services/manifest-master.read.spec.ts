jest.mock('@kubernetes/client-node', () => ({}));

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ManifestMasterService,
  WITHHELD_BY_HISTORY,
  parseReadLogs,
  readScript,
} from './manifest-master.service';

/**
 * The read job's output is pod logs, and pod logs are readable by more than
 * the API. The script is run for real against a directory shaped like a
 * master's, and its raw output — not the parsed map — is checked for the
 * secret, because the output is what leaks.
 */
const hasTools =
  spawnSync('sh', ['-c', 'command -v sha256sum && command -v base64'])
    .status === 0;
const ifTools = hasTools ? describe : describe.skip;

const SECRET = 'tok-7f3a9c-secret-value';

const owned = (kind: string, body: string) => `apiVersion: v1
kind: ${kind}
metadata:
  name: x
  labels:
    flui.cloud/owner-kind: "platform"
    flui.cloud/owner-id: "flui-core"
${body}
`;

function runRead(files: Record<string, string>, withhold: string[] | 'all') {
  const dir = mkdtempSync(join(tmpdir(), 'flui-master-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    const result = spawnSync('sh', ['-c', readScript(withhold, dir)], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

ifTools('what the read job lets out of the master', () => {
  const files = {
    '00-secrets.yaml': owned('Secret', `stringData:\n  A: "${SECRET}"`),
    '04d-alertmanager.yaml': owned(
      'ConfigMap',
      `data:\n  credentials: "${SECRET}"`,
    ),
    '06-custom.yaml': owned('ConfigMap', `data:\n  token: "${SECRET}"`),
    '07-plain.yaml': owned('ConfigMap', 'data:\n  a: "1"'),
  };

  it('prints no body for a Secret, a file named in the withhold list, or one withheld by history', () => {
    const out = runRead(files, ['06-custom.yaml']);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(Buffer.from(SECRET).toString('base64'));
    for (const encoded of out
      .split('\n')
      .filter((l) => l.startsWith('BODY '))
      .map((l) => Buffer.from(l.slice(5), 'base64').toString('utf8'))) {
      expect(encoded).not.toContain(SECRET);
    }

    const held = parseReadLogs(out);
    expect(held.get('00-secrets.yaml')).toMatchObject({ carriesSecret: true });
    expect(held.get('00-secrets.yaml')?.content).toBeUndefined();
    for (const name of ['04d-alertmanager.yaml', '06-custom.yaml']) {
      expect(held.get(name)).toMatchObject({
        withheld: true,
        declaresProvenance: true,
      });
      expect(held.get(name)?.content).toBeUndefined();
      expect(held.get(name)?.sha).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(held.get('07-plain.yaml')?.content).toBe(files['07-plain.yaml']);
  });

  it('withholds every body when asked for digests only', () => {
    const out = runRead(files, 'all');
    expect(out).not.toContain('BODY ');
    expect([...parseReadLogs(out).keys()].sort()).toEqual(
      Object.keys(files).sort(),
    );
  });

  it('names the images a withheld file declares, and nothing else from it', () => {
    const api = `${owned(
      'Deployment',
      `spec:
  template:
    spec:
      containers:
      - name: flui-api
        image: ghcr.io/flui-cloud/core:25eeb87
        env:
        - name: TOKEN
          value: "${SECRET}"
      - name: sidecar
        image: "ghcr.io/x/y:1 ${SECRET}"
      - name: other
        image: ghcr.io/x/y:1 # ${SECRET}
      - name: odd
        image: ghcr.io/x/y:$(${SECRET})
      - name: double
        image: "ghcr.io/x/double:2"
      - name: single
        image: 'ghcr.io/x/single:3'
      - name: open
        image: "ghcr.io/x/open:4 ${SECRET}"
      - name: mixed
        image: "ghcr.io/x/mixed:5'`,
    )}`;
    const out = runRead(
      {
        '09-flui-api.yaml': api,
        '00-secrets.yaml': `${owned('Secret', `stringData:\n  A: "${SECRET}"`)}spec:\n  image: ghcr.io/x/secret:1\n`,
      },
      'all',
    );
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('BODY ');
    expect(out).not.toContain('ghcr.io/x/secret');

    const held = parseReadLogs(out);
    expect(held.get('09-flui-api.yaml')).toMatchObject({
      withheld: true,
      images: [
        'ghcr.io/flui-cloud/core:25eeb87',
        'ghcr.io/x/double:2',
        'ghcr.io/x/single:3',
      ],
    });
    expect(held.get('09-flui-api.yaml')?.content).toBeUndefined();
    expect(held.get('00-secrets.yaml')?.images).toBeUndefined();
  });

  it('counts a withheld file without an owner label as unclaimed', () => {
    const out = runRead(
      { '06-custom.yaml': 'kind: ConfigMap\nmetadata:\n  name: x\n' },
      ['06-custom.yaml'],
    );
    expect(parseReadLogs(out).get('06-custom.yaml')).toMatchObject({
      withheld: true,
      declaresProvenance: false,
    });
  });
});

describe('the read job script', () => {
  it('withholds every file an earlier release rendered a password or key into', () => {
    expect([...WITHHELD_BY_HISTORY].sort()).toEqual([
      '02-postgres.yaml',
      '03-redis.yaml',
      '04d-alertmanager.yaml',
      '08-grafana.yaml',
      '09-flui-api.yaml',
    ]);
  });

  it('always withholds the files that carried a secret in earlier releases', () => {
    const script = readScript([]);
    for (const name of WITHHELD_BY_HISTORY) expect(script).toContain(name);
  });

  it('parses an image line only for a file it saw, and never for a Secret', () => {
    const held = parseReadLogs(
      [
        'FILE 00-s.yaml a secret',
        'IMAGE 00-s.yaml ghcr.io/x/y:1',
        'FILE 09-flui-api.yaml b withheld 1 1',
        'IMAGE 09-flui-api.yaml ghcr.io/flui-cloud/core:25eeb87',
        'IMAGE 09-flui-api.yaml ghcr.io/x/y:1 extra',
        'IMAGE 09-flui-api.yaml "quoted:1"',
        "IMAGE 09-flui-api.yaml 'single:2'",
        `IMAGE 09-flui-api.yaml "mixed:3'`,
        'IMAGE 09-flui-api.yaml "inner"quote:4"',
        'IMAGE 09-flui-api.yaml "$(leak):5"',
        'IMAGE 09-flui-api.yaml ""',
        'IMAGE 10-unknown.yaml ghcr.io/x/y:1',
      ].join('\n'),
    );
    expect(held.get('00-s.yaml')?.images).toBeUndefined();
    expect(held.get('09-flui-api.yaml')?.images).toEqual([
      'ghcr.io/flui-cloud/core:25eeb87',
      'quoted:1',
      'single:2',
    ]);
    expect(held.has('10-unknown.yaml')).toBe(false);
  });

  it('keeps a withheld file’s images on that file when its name comes back again as a plain one', () => {
    const body = Buffer.from('kind: ConfigMap\n').toString('base64');
    const held = parseReadLogs(
      [
        'FILE 06-custom.yaml a withheld 1 1',
        'IMAGE 06-custom.yaml ghcr.io/x/withheld:1',
        'FILE 06-custom.yaml b plain',
        `BODY ${body}`,
        'IMAGE 06-custom.yaml ghcr.io/x/plain:2',
      ].join('\n'),
    );
    expect(held.get('06-custom.yaml')).toEqual({
      sha: 'b',
      carriesSecret: false,
      content: 'kind: ConfigMap\n',
      images: ['ghcr.io/x/plain:2'],
    });
  });

  it('drops a name that could break out of the shell', () => {
    expect(readScript(['a"; rm -rf /; ".yaml'])).not.toContain('rm -rf');
  });

  it('is the script the service runs', async () => {
    const applied: string[] = [];
    const kube = {
      applyManifest: jest.fn(async (_kc: string, manifest: string) => {
        applied.push(manifest);
      }),
      getResource: jest.fn(async () => ({ status: { succeeded: 1 } })),
      deleteResource: jest.fn(async () => undefined),
      makeKubeConfig: jest.fn(() => ({
        makeApiClient: () => ({
          listNamespacedPod: async () => ({
            items: [{ metadata: { name: 'p' } }],
          }),
        }),
      })),
      getPodLogs: jest.fn(async () => 'FILE a.yaml abc withheld 1 1\n'),
    };
    const service = new ManifestMasterService(kube as never);
    const held = await service.read('kc', 'node', ['06-custom.yaml']);
    expect(applied[0]).toContain('06-custom.yaml');
    expect(applied[0]).toContain('04d-alertmanager.yaml');
    expect(held.get('a.yaml')).toMatchObject({ withheld: true });
  });
});
