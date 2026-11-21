import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogSeederService } from './catalog-seeder.service';

let seedDir: string;

jest.mock('../../../common/utils/project-root.util', () => ({
  getProjectPath: () => seedDir,
}));

function build(load: (raw: string) => unknown) {
  const repo = {
    findBySlugAndVersion: jest.fn(async () => null),
    upsert: jest.fn(async (d: unknown) => d),
    cleanupPreviousVersions: jest.fn(async () => ({
      deactivated: 0,
      deleted: 0,
    })),
    retireSharedSlugsNotIn: jest.fn(async () => ({
      retiredSlugs: [],
      deleted: 0,
    })),
  };
  const seeder = new CatalogSeederService(
    repo as never,
    { load: jest.fn(load) } as never,
    {} as never,
  );
  const seed = () => (seeder as unknown as { seed(): Promise<void> }).seed();
  return { repo, seed };
}

const manifestFor = (raw: string) => ({
  manifest: {
    metadata: { id: raw, version: '1', name: raw, category: 'developer-tools' },
    spec: { type: 'standalone' },
  },
  checksum: raw,
});

describe('CatalogSeederService retires apps whose seed file is gone', () => {
  beforeEach(() => {
    seedDir = mkdtempSync(join(tmpdir(), 'seed-'));
    writeFileSync(join(seedDir, 'gitea.flui.yaml'), 'gitea');
    writeFileSync(join(seedDir, 'umami.flui.yaml'), 'umami');
  });

  afterEach(() => rmSync(seedDir, { recursive: true, force: true }));

  it('keeps exactly the apps the seed files carry', async () => {
    const { repo, seed } = build(manifestFor);

    await seed();

    expect(repo.retireSharedSlugsNotIn).toHaveBeenCalledTimes(1);
    const [kept] = repo.retireSharedSlugsNotIn.mock.calls[0] as unknown as [
      string[],
    ];
    expect([...kept].sort((a, b) => a.localeCompare(b))).toEqual([
      'gitea',
      'umami',
    ]);
  });

  it('retires nothing when one seed file cannot be read', async () => {
    const { repo, seed } = build((raw) => {
      if (raw === 'umami') throw new Error('bad manifest');
      return manifestFor(raw);
    });

    await seed();

    expect(repo.retireSharedSlugsNotIn).not.toHaveBeenCalled();
  });

  it('retires nothing when the seed directory holds no manifest', async () => {
    rmSync(join(seedDir, 'gitea.flui.yaml'));
    rmSync(join(seedDir, 'umami.flui.yaml'));
    const { repo, seed } = build(manifestFor);

    await seed();

    expect(repo.retireSharedSlugsNotIn).not.toHaveBeenCalled();
  });
});
