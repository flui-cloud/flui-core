jest.mock('@kubernetes/client-node', () => ({}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { CatalogSchemaValidatorService } from '../services/catalog-schema-validator.service';
import { CatalogService } from '../services/catalog.service';
import { CatalogSpec } from '../interfaces/catalog-manifest.interface';
import {
  isOptionOn,
  mirrorPoolerOptions,
  poolerChoice,
  resolveInstallOptions,
} from './catalog-options.util';

const seedSpec = (file: string): CatalogSpec =>
  new CatalogSchemaValidatorService().validate(
    load(readFileSync(join(__dirname, '..', 'seed', file), 'utf8')),
  ).spec;

describe('install options', () => {
  const postgres = seedSpec('postgresql.flui.yaml');

  it('writes every declared option out, defaults resolved', () => {
    expect(resolveInstallOptions(postgres, {})).toEqual({
      pooler: true,
      poolerSessionMode: false,
    });
    expect(resolveInstallOptions(postgres, undefined)).toEqual({
      pooler: true,
      poolerSessionMode: false,
    });
  });

  it('keeps what the person chose', () => {
    expect(
      resolveInstallOptions(postgres, {
        pooler: true,
        poolerSessionMode: true,
      }),
    ).toEqual({ pooler: true, poolerSessionMode: true });
  });

  it('turns off an option whose required option is off', () => {
    expect(
      resolveInstallOptions(postgres, {
        pooler: false,
        poolerSessionMode: true,
      }),
    ).toEqual({ pooler: false, poolerSessionMode: false });
    expect(
      isOptionOn(
        postgres,
        { pooler: false, poolerSessionMode: true },
        'poolerSessionMode',
      ),
    ).toBe(false);
  });

  it('asks for a pooler in transaction mode by default, session on request, none when declined', () => {
    expect(poolerChoice(postgres, {})).toEqual({ mode: 'transaction' });
    expect(poolerChoice(postgres, { poolerSessionMode: true })).toEqual({
      mode: 'session',
    });
    expect(poolerChoice(postgres, { pooler: false })).toBeNull();
  });

  it('gives no pooler to a block that does not declare the option', () => {
    const mariadb = seedSpec('mariadb.flui.yaml');
    expect(poolerChoice(mariadb, {})).toBeNull();
    expect(poolerChoice(mariadb, { pooler: true })).toBeNull();
  });

  it('leaves a composed app reading its options as before', () => {
    const composed = {
      type: 'composed',
      options: [{ key: 'office', label: 'Office', default: false }],
      components: [],
    } as unknown as CatalogSpec;
    expect(resolveInstallOptions(composed, {})).toEqual({ office: false });
    expect(resolveInstallOptions(composed, { office: true })).toEqual({
      office: true,
    });
  });
});

describe('the options a catalog detail shows', () => {
  it('lists the options of a building block, with what each requires', () => {
    const preview = (
      CatalogService.prototype as unknown as {
        buildOptionsPreview: (spec: CatalogSpec) => unknown;
      }
    ).buildOptionsPreview(seedSpec('postgresql.flui.yaml'));
    expect(preview).toEqual([
      expect.objectContaining({ key: 'pooler', default: true }),
      expect.objectContaining({
        key: 'poolerSessionMode',
        default: false,
        requires: 'pooler',
      }),
    ]);
  });
});

describe('mirrorPoolerOptions', () => {
  it('states no pooler for a copy of an unknown source', () => {
    expect(mirrorPoolerOptions(undefined)).toEqual({
      pooler: false,
      poolerSessionMode: false,
    });
    expect(mirrorPoolerOptions(null)).toEqual(mirrorPoolerOptions({}));
  });

  it('copies the mode of a source pooler', () => {
    expect(
      mirrorPoolerOptions({
        pooler: { enabled: true, mode: 'session' } as never,
      }),
    ).toEqual({ pooler: true, poolerSessionMode: true });
  });
});
