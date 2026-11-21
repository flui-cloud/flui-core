import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { CatalogSchemaValidatorService } from './catalog-schema-validator.service';
import {
  CatalogSpecBuildingBlock,
  CatalogSpecComposed,
} from '../interfaces/catalog-manifest.interface';

const SEED_DIR = join(__dirname, '..', 'seed');
const seed = (file: string): unknown =>
  load(readFileSync(join(SEED_DIR, file), 'utf8'));

describe('CatalogSchemaValidatorService', () => {
  let service: CatalogSchemaValidatorService;

  beforeEach(() => {
    service = new CatalogSchemaValidatorService();
  });

  // `engine` is not in the published @flui-cloud/spec schema yet, and the component definition
  // there is additionalProperties:false — so it only survives via FORWARD_COMPAT_FIELDS.
  describe('declared engine survives validation', () => {
    it('keeps engine on a composed component', () => {
      const manifest = service.validate(seed('umami.flui.yaml'));
      const spec = manifest.spec as CatalogSpecComposed;
      const db = spec.components.find((c) => c.name === 'db');
      expect(db?.engine).toBe('postgres');
    });

    it('leaves the web component of the same app without an engine', () => {
      const manifest = service.validate(seed('umami.flui.yaml'));
      const spec = manifest.spec as CatalogSpecComposed;
      const web = spec.components.find((c) => c.name === 'umami');
      expect(web).toBeDefined();
      expect(web?.engine).toBeUndefined();
    });

    it('keeps engine on a building block', () => {
      const manifest = service.validate(seed('postgresql.flui.yaml'));
      expect((manifest.spec as CatalogSpecBuildingBlock).engine).toBe(
        'postgres',
      );
    });

    it('records the engine a component really speaks, not what its name says', () => {
      const manifest = service.validate(seed('ferretdb.flui.yaml'));
      const spec = manifest.spec as CatalogSpecComposed;
      const db = spec.components.find((c) => c.name === 'db');
      expect(db?.image.repository).toBe('ferretdb/postgres-documentdb');
      expect(db?.engine).toBe('postgres');
    });
  });

  describe('install options on a building block', () => {
    it('keeps the pooler options of the PostgreSQL seed', () => {
      const manifest = service.validate(seed('postgresql.flui.yaml'));
      const options = (manifest.spec as CatalogSpecBuildingBlock).options;
      expect(options?.map((o) => [o.key, o.default, o.requires])).toEqual([
        ['pooler', true, undefined],
        ['poolerSessionMode', false, 'pooler'],
      ]);
    });

    it('still checks the options of a composed app against the published schema', () => {
      const manifest = seed('umami.flui.yaml') as {
        spec: { options?: unknown };
      };
      manifest.spec.options = [{ key: 'x', label: 'X', bogus: true }];
      expect(() => service.validate(manifest)).toThrow();
    });
  });

  it('validates every seed that declares an engine', () => {
    const files = [
      'umami.flui.yaml',
      'nextcloud.flui.yaml',
      'penpot.flui.yaml',
      'twenty.flui.yaml',
      'n8n.flui.yaml',
      'ferretdb.flui.yaml',
      'wordpress-composed.flui.yaml',
      'flui-demo-activity.flui.yaml',
      'postgresql.flui.yaml',
      'pgvector.flui.yaml',
      'valkey.flui.yaml',
      'kafka.flui.yaml',
    ];
    for (const file of files) {
      expect(() => service.validate(seed(file))).not.toThrow();
    }
  });

  it('keeps the component a post-install command runs in', () => {
    const manifest = service.validate(seed('penpot.flui.yaml'));
    const steps = (manifest.spec as CatalogSpecComposed).postInstall;
    expect(steps?.map((s) => [s.name, s.exec?.component])).toEqual([
      ['create-admin', 'backend'],
    ]);
  });

  it('keeps the pull policy of an image whose tag moves', () => {
    const manifest = service.validate(seed('postgresql.flui.yaml'));
    expect(
      (manifest.spec as { imagePullPolicy?: string }).imagePullPolicy,
    ).toBe('Always');
  });

  describe('generated key material', () => {
    const withEnv = (env: unknown[]) => {
      const manifest = seed('umami.flui.yaml') as {
        spec: { components: Array<{ name: string; env: unknown[] }> };
      };
      manifest.spec.components.find((c) => c.name === 'umami')!.env = env;
      return manifest;
    };

    it('keeps a generated key and the certificate made from it', () => {
      const manifest = service.validate(
        withEnv([
          {
            name: 'KEY',
            valueFrom: { generate: 'rsa-private-key', bits: 4096 },
          },
          {
            name: 'CERT',
            valueFrom: {
              certificateFor: 'KEY',
              commonName: 'ca',
              validDays: 365,
            },
          },
        ]),
      );
      const env = (manifest.spec as CatalogSpecComposed).components.find(
        (c) => c.name === 'umami',
      )!.env;
      expect(env.map((e) => e.valueFrom)).toEqual([
        { generate: 'rsa-private-key', bits: 4096 },
        { certificateFor: 'KEY', commonName: 'ca', validDays: 365 },
      ]);
    });

    it('refuses a certificate for a key the component does not generate', () => {
      expect(() =>
        service.validate(
          withEnv([{ name: 'CERT', valueFrom: { certificateFor: 'MISSING' } }]),
        ),
      ).toThrow('Invalid catalog manifest');
    });

    it('refuses a key size it does not support', () => {
      expect(() =>
        service.validate(
          withEnv([
            {
              name: 'KEY',
              valueFrom: { generate: 'rsa-private-key', bits: 1024 },
            },
          ]),
        ),
      ).toThrow('Invalid catalog manifest');
    });

    it('keeps a bcrypt hash of a generated secret', () => {
      const manifest = service.validate(
        withEnv([
          { name: 'PASSWORD', valueFrom: { generate: 'secret', length: 32 } },
          { name: 'HASH', valueFrom: { bcryptOf: 'PASSWORD' } },
        ]),
      );
      const env = (manifest.spec as CatalogSpecComposed).components.find(
        (c) => c.name === 'umami',
      )!.env;
      expect(env[1].valueFrom).toEqual({ bcryptOf: 'PASSWORD' });
    });

    it('refuses a bcrypt hash of a plain value', () => {
      expect(() =>
        service.validate(
          withEnv([
            { name: 'USER', value: 'admin' },
            { name: 'HASH', valueFrom: { bcryptOf: 'USER' } },
          ]),
        ),
      ).toThrow('Invalid catalog manifest');
    });

    it('still refuses a generator it does not know', () => {
      expect(() =>
        service.validate(
          withEnv([
            { name: 'KEY', valueFrom: { generate: 'ed25519', length: 32 } },
          ]),
        ),
      ).toThrow('Invalid catalog manifest');
    });
  });

  describe('config files of a composed component', () => {
    const withConfig = (content: string) => {
      const manifest = seed('umami.flui.yaml') as {
        spec: { components: Array<{ name: string; configFiles?: unknown[] }> };
      };
      manifest.spec.components.find((c) => c.name === 'umami')!.configFiles = [
        { path: '/etc/app.conf', content },
      ];
      return manifest;
    };

    it('may name the address of a sibling', () => {
      expect(() =>
        service.validate(
          withConfig('upstream {{ components.db.host }}:5432 {{self.fqdn}}'),
        ),
      ).not.toThrow();
    });

    it('may not read a variable, which would store it unencrypted', () => {
      expect(() =>
        service.validate(
          withConfig('password = {{components.db.env.POSTGRES_PASSWORD}}'),
        ),
      ).toThrow('Invalid catalog manifest');
    });
  });
});
