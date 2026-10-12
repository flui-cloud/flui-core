jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { CatalogInstallerService } from './catalog-installer.service';
import { CatalogSchemaValidatorService } from './catalog-schema-validator.service';
import { CatalogManifest } from '../interfaces/catalog-manifest.interface';
import { CatalogAppType } from '../enums/catalog-app-type.enum';

const manifestOf = (file: string): CatalogManifest =>
  new CatalogSchemaValidatorService().validate(
    load(readFileSync(join(__dirname, '..', 'seed', file), 'utf8')),
  );

function harness(manifest: CatalogManifest) {
  const definition = {
    id: 'def-1',
    slug: manifest.metadata.id,
    name: manifest.metadata.name,
    version: manifest.metadata.version,
    appType: manifest.spec.type,
    manifest,
  };
  const created: Array<Record<string, unknown>> = [];
  const definitionRepo = {
    findPublishedBySlug: jest.fn(async () => definition),
    findActiveBySlug: jest.fn(async () => definition),
  };
  const installRepo = {
    create: jest.fn(async (row: Record<string, unknown>) => {
      created.push(row);
      return { id: 'install-1', ...row };
    }),
    update: jest.fn(),
  };
  const operationRepo = {
    create: jest.fn((op: unknown) => op),
    save: jest.fn(async (op: object) => ({ id: 'op-1', ...op })),
  };
  const clustersService = {
    checkResourceAvailability: jest.fn(async () => ({ canDeploy: true })),
  };
  const catalogService = {
    assertCatalogAppInstallableOnCluster: jest.fn(),
  };
  const svc = new CatalogInstallerService(
    { add: jest.fn() } as never,
    definitionRepo as never,
    installRepo as never,
    operationRepo as never,
    {} as never,
    {} as never,
    {} as never,
    catalogService as never,
    clustersService as never,
  );
  return { svc, created, clustersService };
}

describe('the pooler in the install footprint and the install row', () => {
  const postgres = manifestOf('postgresql.flui.yaml');

  it('counts the pooler when the install takes the default', () => {
    const { svc } = harness(postgres);
    expect(svc.computeInstallFootprint(postgres, {})).toEqual({
      cpu: 250 + 25,
      memory: 2048 + 128,
    });
  });

  it('does not count it when the install declines the pooler', () => {
    const { svc } = harness(postgres);
    expect(svc.computeInstallFootprint(postgres, { pooler: false })).toEqual({
      cpu: 250,
      memory: 2048,
    });
  });

  it('never scales the pooler with the database overrides', () => {
    const { svc } = harness(postgres);
    expect(
      svc.computeInstallFootprint(
        postgres,
        {},
        { cpu: { request: '1' }, memory: { limit: '4Gi' } },
      ),
    ).toEqual({ cpu: 1000 + 25, memory: 4096 + 128 });
  });

  it('writes the pooler choice on the install row explicitly', async () => {
    const { svc, created } = harness(postgres);
    await svc.install('postgresql', {
      clusterId: 'c1',
      displayName: 'pg',
    } as never);
    expect(created[0].options).toEqual({
      pooler: true,
      poolerSessionMode: false,
    });
  });

  it('writes an internal caller’s refusal of the pooler as stated', async () => {
    const { svc, created } = harness(postgres);
    await svc.installBuildingBlock('postgresql', 'c1', 'u1', undefined, null, {
      pooler: false,
    });
    expect(created[0].options).toEqual({
      pooler: false,
      poolerSessionMode: false,
    });
  });

  it('refuses an option that is not a boolean instead of reading it as the default', async () => {
    const { svc, created } = harness(postgres);
    await expect(
      svc.install('postgresql', {
        clusterId: 'c1',
        displayName: 'pg',
        options: { pooler: 'false' },
      } as never),
    ).rejects.toThrow(/true or false: pooler/);
    expect(created).toEqual([]);
  });

  it('refuses an option the seed does not declare and names the valid ones', async () => {
    const { svc, created } = harness(postgres);
    await expect(
      svc.install('postgresql', {
        clusterId: 'c1',
        displayName: 'pg',
        options: { poolr: false },
      } as never),
    ).rejects.toThrow(
      /no install option poolr; its options are pooler, poolerSessionMode/,
    );
    await expect(
      svc.preflight('postgresql', {
        clusterId: 'c1',
        options: { poolr: false },
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(created).toEqual([]);
  });

  it('asks the capacity gate for the pooler too', async () => {
    const { svc, clustersService } = harness(postgres);
    await svc.install('postgresql', {
      clusterId: 'c1',
      displayName: 'pg',
    } as never);
    expect(clustersService.checkResourceAvailability).toHaveBeenCalledWith(
      'c1',
      275,
      2176,
      1,
    );
  });

  it('leaves a standalone app without a pooler line', () => {
    const { svc } = harness(postgres);
    const standalone = {
      ...postgres,
      spec: { ...postgres.spec, type: CatalogAppType.STANDALONE },
    } as unknown as CatalogManifest;
    expect(svc.computeInstallFootprint(standalone, {})).toEqual({
      cpu: 250,
      memory: 2048,
    });
  });
});
