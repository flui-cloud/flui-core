import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindIngressTls,
  placeholdersIn,
  renderManifestFile,
  renderTemplate,
  valuesDigest,
} from './manifest-render.util';

/**
 * Parity with the installer, not with a description of it: the `render_manifest`
 * function is lifted out of `k3s-master-init.sh` and run with the real
 * `envsubst`. Skipped when this machine has neither the sibling checkout nor
 * the binary.
 */
const BOOTSTRAP = join(__dirname, '../../../../../bootstrap-scripts');
const INSTALLER = join(BOOTSTRAP, 'scripts/k3s-master-init.sh');
const hasEnvsubst =
  spawnSync('sh', ['-c', 'command -v envsubst'], { encoding: 'utf8' })
    .status === 0;
const canCompare = hasEnvsubst && existsSync(INSTALLER);
const ifInstaller = canCompare ? describe : describe.skip;

function installerRenderFunction(): string {
  const script = readFileSync(INSTALLER, 'utf8');
  const match = /^render_manifest\(\) \{\n[\s\S]*?\n\}\n/m.exec(script);
  if (!match) throw new Error('render_manifest not found in the installer');
  return match[0];
}

function installerRender(
  template: string,
  env: Record<string, string>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'flui-render-'));
  try {
    const src = join(dir, 'in.yaml');
    const dst = join(dir, 'out.yaml');
    writeFileSync(src, template);
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\n${installerRenderFunction()}\nrender_manifest "$1" "$2"`,
        'render',
        src,
        dst,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return readFileSync(dst, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifestFiles(): string[] {
  const root = join(BOOTSTRAP, 'manifests');
  const out: string[] = [];
  for (const set of readdirSync(root, { withFileTypes: true })) {
    if (!set.isDirectory()) continue;
    for (const file of readdirSync(join(root, set.name))) {
      if (file.endsWith('.yaml')) out.push(join(root, set.name, file));
    }
  }
  return out.sort();
}

/** Values that would expose a renderer treating them as patterns or escapes. */
const awkward = (name: string) => `v-${name}/&\\1$HOME|"'x`;

ifInstaller('the renderer against the installer', () => {
  it.each(manifestFiles().map((f) => [f.split('/manifests/')[1], f]))(
    'renders %s exactly as the installer does',
    (_label, path) => {
      const template = readFileSync(path as string, 'utf8');
      const names = placeholdersIn(template);
      const env: Record<string, string> = {};
      names.forEach((n, i) => {
        if (i % 3 !== 2) env[n] = awkward(n);
      });
      expect(renderTemplate(template, env)).toBe(
        installerRender(template, env),
      );
    },
  );

  it('agrees on the edges: bare names, unclosed braces, neighbours and unset', () => {
    const template = [
      'a: ${ONE} $ONE ${ONE}x $ONEX $$ONE ${ONE',
      'b: ${TWO:-d} ${TWO} {{ $labels.namespace }} ${1} $1',
      'c: ${UNSET} $UNSET ${ONE}${TWO}',
      '',
    ].join('\n');
    const env = { ONE: 'first', TWO: 'se&cond' };
    expect(renderTemplate(template, env)).toBe(installerRender(template, env));
  });
});

describe('what the renderer does', () => {
  it('substitutes only the names the file declares in braces', () => {
    expect(
      renderTemplate('x: ${A} $A $B {{ $labels.x }}', { A: '1', B: '2' }),
    ).toBe('x: 1 1 $B {{ $labels.x }}');
  });

  it('writes nothing for a declared name with no value', () => {
    expect(renderTemplate('x: "${A}"', {})).toBe('x: ""');
  });

  it('leaves a raw file as it was downloaded', () => {
    const template = 'x: ${VOL_DIR}';
    expect(
      renderManifestFile('01a.yaml', template, {}, { raw: ['01a.yaml'] }),
    ).toBe(template);
  });

  it('binds the IngressRoute exactly where the installer did', () => {
    const template = 'spec:\n  tls: {}\n    tls: {}\n';
    expect(bindIngressTls(template, 'flui-system-tls')).toBe(
      'spec:\n  tls:\n    secretName: flui-system-tls\n    tls: {}\n',
    );
    expect(
      renderManifestFile(
        '10-flui-web.yaml',
        template,
        {},
        {
          ingressTls: {
            secretName: 'flui-system-tls',
            files: ['09-flui-api.yaml'],
          },
        },
      ),
    ).toBe(template);
  });

  it('digests values without regard to order', () => {
    expect(valuesDigest({ A: '1', B: '2' })).toBe(
      valuesDigest({ B: '2', A: '1' }),
    );
    expect(valuesDigest({ A: '1' })).not.toBe(valuesDigest({ A: '2' }));
  });
});
