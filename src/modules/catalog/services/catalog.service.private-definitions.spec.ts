jest.mock('@kubernetes/client-node', () => ({}));

import { ConflictException } from '@nestjs/common';
import { CatalogService, sharedSlugRefusal } from './catalog.service';
import { CatalogAppDefinitionEntity } from '../entities/catalog-app-definition.entity';

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';

type Row = Partial<CatalogAppDefinitionEntity> & { id: string };

/** Same ownership semantics as the Postgres-backed repository. */
function fakeRepository(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  let next = 0;
  const sameOwner = (r: Row, owner: string | null) =>
    (r.ownerUserId ?? null) === owner;
  const repo = {
    rows,
    hasShared: jest.fn(async (slug: string) =>
      rows.some((r) => r.slug === slug && sameOwner(r, null)),
    ),
    findBySlugAndVersion: jest.fn(
      async (slug: string, version: string, owner: string | null = null) =>
        rows.find(
          (r) =>
            r.slug === slug && r.version === version && sameOwner(r, owner),
        ) ?? null,
    ),
    upsert: jest.fn(async (data: Partial<CatalogAppDefinitionEntity>) => {
      const existing = await repo.findBySlugAndVersion(
        data.slug!,
        data.version!,
        data.ownerUserId ?? null,
      );
      if (existing) return Object.assign(existing, data);
      const row = { id: `row-${next++}`, ...data } as Row;
      rows.push(row);
      return row;
    }),
    cleanupPreviousVersions: jest.fn(
      async (slug: string, keep: string, owner: string | null = null) => {
        const stale = rows.filter(
          (r) => r.slug === slug && r.version !== keep && sameOwner(r, owner),
        );
        for (const r of stale) rows.splice(rows.indexOf(r), 1);
        return { deactivated: stale.length, deleted: stale.length };
      },
    ),
    listPublished: jest.fn(async () =>
      rows.filter((r) => sameOwner(r, null) && r.isActive && r.isPublished),
    ),
    findPublishedBySlug: jest.fn(async (slug: string, owner?: string) => {
      const live = (o: string | null) =>
        rows.find(
          (r) =>
            r.slug === slug && r.isActive && r.isPublished && sameOwner(r, o),
        );
      return (owner ? live(owner) : undefined) ?? live(null) ?? null;
    }),
  };
  return repo;
}

function manifestLoader() {
  return {
    load: jest.fn((raw: string) => {
      const [id, version] = raw.split('@');
      return {
        manifest: {
          apiVersion: 'flui/v1',
          kind: 'CatalogApp',
          metadata: { id, version, name: id, category: 'developer-tools' },
          spec: { type: 'standalone' },
        },
        checksum: `sum-${raw}`,
      };
    }),
  };
}

function build(seed: Row[] = []) {
  const repo = fakeRepository(seed);
  const service = new CatalogService(
    repo as never,
    {} as never,
    manifestLoader() as never,
    {} as never,
  );
  return { repo, service };
}

const sharedGitea: Row = {
  id: 'shared-gitea',
  slug: 'gitea',
  version: '1.22',
  name: 'Gitea',
  category: 'developer-tools',
  isActive: true,
  isPublished: true,
  ownerUserId: null,
};

describe('CatalogService.upsertFromYaml — definitions private to their owner', () => {
  it('refuses a manifest reusing a shared id before writing anything', async () => {
    const { repo, service } = build([{ ...sharedGitea }]);

    const attempt = service.upsertFromYaml('gitea@9.9', OWNER_A);

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(sharedSlugRefusal('gitea'));
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.cleanupPreviousVersions).not.toHaveBeenCalled();
    expect(repo.rows).toEqual([sharedGitea]);
  });

  it('tells the person which field to change', () => {
    expect(sharedSlugRefusal('gitea')).toBe(
      '"gitea" is the id of an app in the Flui catalog, which only Flui itself can change. ' +
        'Change metadata.id in your flui.yaml to an id of your own and deploy again.',
    );
  });

  it('stores a new id as a definition of the caller, absent from the shared list', async () => {
    const { repo, service } = build([{ ...sharedGitea }]);

    const def = await service.upsertFromYaml('mine@1', OWNER_A);

    expect(def.ownerUserId).toBe(OWNER_A);
    const listed = await service.listPublic();
    expect(listed.map((d) => d.slug)).toEqual(['gitea']);
    expect(await repo.findPublishedBySlug('mine', OWNER_B)).toBeNull();
    expect(await repo.findPublishedBySlug('mine')).toBeNull();
  });

  it('lets a second owner hold its own definition under the same id', async () => {
    const { repo, service } = build();

    const a = await service.upsertFromYaml('mine@1', OWNER_A);
    const b = await service.upsertFromYaml('mine@1', OWNER_B);

    expect(a.id).not.toBe(b.id);
    expect(repo.rows.map((r) => r.ownerUserId).sort()).toEqual([
      OWNER_A,
      OWNER_B,
    ]);
  });

  it('never updates another owner’s definition', async () => {
    const { repo, service } = build();
    await service.upsertFromYaml('mine@1', OWNER_A);
    const before = { ...repo.rows[0] };

    await service.upsertFromYaml('mine@1-changed', OWNER_B);

    expect(repo.rows[0]).toEqual(before);
    expect(repo.upsert.mock.calls[1][0].ownerUserId).toBe(OWNER_B);
  });

  it('retires previous versions of the caller’s own rows only', async () => {
    const { repo, service } = build();
    await service.upsertFromYaml('mine@1', OWNER_A);
    await service.upsertFromYaml('mine@1', OWNER_B);

    await service.upsertFromYaml('mine@2', OWNER_A);

    expect(repo.cleanupPreviousVersions).toHaveBeenLastCalledWith(
      'mine',
      '2',
      OWNER_A,
    );
    expect(
      repo.rows.map((r) => `${r.ownerUserId}:${r.version}`).sort(),
    ).toEqual([`${OWNER_A}:2`, `${OWNER_B}:1`]);
  });

  it('returns the unchanged definition without rewriting it', async () => {
    const { repo, service } = build();
    const first = await service.upsertFromYaml('mine@1', OWNER_A);

    const again = await service.upsertFromYaml('mine@1', OWNER_A);

    expect(again).toBe(first);
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });

  it('resolves the caller’s definition for installs and the shared one for everyone else', async () => {
    const { repo, service } = build([{ ...sharedGitea }]);
    await service.upsertFromYaml('mine@1', OWNER_A);

    await expect(
      service.findPublishedBySlug('mine', OWNER_A),
    ).resolves.toMatchObject({ ownerUserId: OWNER_A });
    await expect(service.findPublishedBySlug('mine', OWNER_B)).rejects.toThrow(
      'not found',
    );
    await expect(
      service.findPublishedBySlug('gitea', OWNER_A),
    ).resolves.toMatchObject({ id: 'shared-gitea' });
    expect(repo.findPublishedBySlug).toHaveBeenCalledWith('mine', OWNER_A);
  });
});
