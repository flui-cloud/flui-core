jest.mock('@kubernetes/client-node', () => ({}));

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogInstallerService } from './catalog-installer.service';
import { CatalogSeederService } from './catalog-seeder.service';

const OWNER_A = '11111111-1111-1111-1111-111111111111';

function installer(definitionRepo: object, catalogService: object = {}) {
  return new CatalogInstallerService(
    {} as never,
    definitionRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    catalogService as never,
    {} as never,
  );
}

describe('catalog definition resolution for installs', () => {
  it('resolves the slug for the person installing', async () => {
    const findPublishedBySlug = jest.fn(async () => null);
    const svc = installer({ findPublishedBySlug });

    await expect(
      svc.install('mine', { clusterId: 'c1' } as never, OWNER_A),
    ).rejects.toThrow('Catalog app "mine" not found or not published');
    expect(findPublishedBySlug).toHaveBeenCalledWith('mine', OWNER_A);
  });

  it('gates the cluster on the definition it resolved, not on the slug again', async () => {
    const definition = {
      id: 'own',
      slug: 'mine',
      appType: 'standalone',
      ownerUserId: OWNER_A,
      manifest: { spec: { type: 'standalone', env: [] } },
    };
    const gate = jest.fn(async () => {
      throw new Error('gate reached');
    });
    const svc = installer(
      { findPublishedBySlug: jest.fn(async () => definition) },
      { assertCatalogAppInstallableOnCluster: gate },
    );

    await expect(
      svc.install('mine', { clusterId: 'c1' } as never, OWNER_A),
    ).rejects.toThrow('gate reached');
    expect(gate).toHaveBeenCalledWith(definition, 'c1');
  });
});

describe('CatalogSeederService never reaches a private definition', () => {
  it('reads, writes and cleans up the shared catalog only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    const file = join(dir, 'mine.flui.yaml');
    writeFileSync(file, 'raw');
    const repo = {
      findBySlugAndVersion: jest.fn(async () => null),
      upsert: jest.fn(async (d: unknown) => d),
      cleanupPreviousVersions: jest.fn(async () => ({
        deactivated: 0,
        deleted: 0,
      })),
    };
    const loader = {
      load: jest.fn(() => ({
        manifest: {
          metadata: {
            id: 'mine',
            version: '2',
            name: 'Mine',
            category: 'developer-tools',
          },
          spec: { type: 'standalone' },
        },
        checksum: 'sum',
      })),
    };
    const seeder = new CatalogSeederService(repo as never, loader as never);

    await (
      seeder as unknown as { seedFile(p: string): Promise<void> }
    ).seedFile(file);

    expect(repo.findBySlugAndVersion).toHaveBeenCalledWith('mine', '2');
    expect(repo.upsert.mock.calls[0][0]).toMatchObject({ ownerUserId: null });
    expect(repo.cleanupPreviousVersions).toHaveBeenCalledWith('mine', '2');
    rmSync(dir, { recursive: true, force: true });
  });
});
