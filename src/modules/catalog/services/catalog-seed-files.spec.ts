import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogManifestLoaderService } from './catalog-manifest-loader.service';
import { CatalogSchemaValidatorService } from './catalog-schema-validator.service';
import {
  CatalogComponent,
  CatalogEnvVar,
  CatalogImageSource,
  CatalogManifest,
  CatalogSpecComposed,
} from '../interfaces/catalog-manifest.interface';

const SEED_DIR = join(__dirname, '..', 'seed');
const FILES = readdirSync(SEED_DIR).filter((f) => f.endsWith('.flui.yaml'));
const loader = new CatalogManifestLoaderService(
  new CatalogSchemaValidatorService(),
);

function load(file: string): CatalogManifest {
  return loader.load(readFileSync(join(SEED_DIR, file), 'utf8')).manifest;
}

function imagesOf(manifest: CatalogManifest): CatalogImageSource[] {
  const spec = manifest.spec as {
    image?: CatalogImageSource;
    components?: CatalogComponent[];
  };
  return spec.components?.map((c) => c.image) ?? [spec.image!];
}

function references(value: string | undefined, root: string): string[][] {
  const paths = [...(value ?? '').matchAll(/\{\{([^}]*)\}\}/g)].map((m) =>
    m[1].trim().split('.'),
  );
  return paths.filter((p) => p[0] === root);
}

function upstreamOf(
  name: string,
  byName: Map<string, CatalogComponent>,
  seen = new Set<string>(),
): Set<string> {
  for (const dep of byName.get(name)?.dependsOn ?? []) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    upstreamOf(dep, byName, seen);
  }
  return seen;
}

describe('catalog seed files', () => {
  it.each(FILES)('%s is a valid manifest named after its id', (file) => {
    const manifest = load(file);
    expect(`${manifest.metadata.id}.flui.yaml`).toBe(file);
  });

  it.each(FILES)('%s pins every image to an explicit tag', (file) => {
    for (const image of imagesOf(load(file))) {
      if (image.source) continue;
      expect(image.tag).toBeTruthy();
      expect(image.tag).not.toBe('latest');
    }
  });

  const composed = FILES.filter(
    (f) => (load(f).spec as { type: string }).type === 'composed',
  );

  it.each(composed)('%s only reads components it waits for', (file) => {
    const spec = load(file).spec as CatalogSpecComposed;
    const byName = new Map(spec.components.map((c) => [c.name, c]));
    for (const component of spec.components) {
      for (const dep of component.dependsOn ?? []) {
        expect(byName.has(dep)).toBe(true);
      }
      const upstream = upstreamOf(component.name, byName);
      const ownEnv = new Set(component.env.map((e) => e.name));
      for (const env of component.env) {
        for (const [, target, field, name] of references(
          env.value,
          'components',
        )) {
          expect({ env: env.name, target, known: byName.has(target) }).toEqual({
            env: env.name,
            target,
            known: true,
          });
          if (field === 'env') {
            expect({ env: env.name, waitsFor: upstream.has(target) }).toEqual({
              env: env.name,
              waitsFor: true,
            });
            const declared = byName
              .get(target)!
              .env.some((e: CatalogEnvVar) => e.name === name);
            expect({ env: env.name, reads: name, declared }).toEqual({
              env: env.name,
              reads: name,
              declared: true,
            });
          }
        }
        for (const [, field, name] of references(env.value, 'self')) {
          if (field === 'env') {
            expect({
              env: env.name,
              reads: name,
              own: ownEnv.has(name),
            }).toEqual({ env: env.name, reads: name, own: true });
          }
        }
      }
    }
  });

  it.each(composed)(
    '%s asks for each install input under one name only',
    (file) => {
      const spec = load(file).spec as CatalogSpecComposed;
      const inputs = spec.components.flatMap((c) =>
        c.env
          .filter((e) => e.valueFrom && 'userInput' in e.valueFrom)
          .map((e) => e.name),
      );
      expect(new Set(inputs).size).toBe(inputs.length);
    },
  );

  it('matrix keeps sign-up closed and never talks to other servers', () => {
    const spec = load('matrix.flui.yaml').spec as CatalogSpecComposed;
    const synapse = spec.components.find((c) => c.name === 'synapse')!;
    const config = synapse.configFiles!.find((f) =>
      f.path.endsWith('homeserver.yaml'),
    )!.content;
    expect(config).toContain('enable_registration: false');
    expect(config).toContain('federation_domain_whitelist: []');
    expect(config).toContain('trusted_key_servers: []');
    expect(config).toMatch(/names: \[client\]/);
    expect(config).not.toMatch(/names: \[[^\]]*federation/);
    expect(synapse.ports.every((p) => !p.expose)).toBe(true);
  });

  it('jitsi lets only the host start a meeting and sends media over its one UDP port', () => {
    const spec = load('jitsi.flui.yaml').spec as CatalogSpecComposed;
    const byName = (n: string) => spec.components.find((c) => c.name === n)!;
    const env = (n: string, key: string) =>
      byName(n).env.find((e) => e.name === key)?.value;
    for (const n of ['prosody', 'jicofo', 'web']) {
      expect(env(n, 'ENABLE_AUTH')).toBe('1');
      expect(env(n, 'AUTH_TYPE')).toBe('internal');
    }
    expect(byName('jvb').udpPorts).toEqual([{ name: 'media', port: 10000 }]);
    expect(env('jvb', 'JVB_PORT')).toBe('10000');
    expect(
      spec.components.filter((c) => c.udpPorts?.length).map((c) => c.name),
    ).toEqual(['jvb']);
    expect(
      spec.components.flatMap((c) => c.ports ?? []).filter((p) => p.expose),
    ).toEqual([expect.objectContaining({ name: 'http', internal: 8000 })]);
  });
});
