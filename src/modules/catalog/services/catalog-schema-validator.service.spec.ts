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
      const manifest = service.validate(seed('immich.flui.yaml'));
      const spec = manifest.spec as CatalogSpecComposed;
      const cache = spec.components.find((c) => c.name === 'redis');
      expect(cache?.image.repository).toBe('valkey/valkey');
      expect(cache?.engine).toBe('valkey');
    });
  });

  it('validates every seed that declares an engine', () => {
    const files = [
      'umami.flui.yaml',
      'immich.flui.yaml',
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
});
