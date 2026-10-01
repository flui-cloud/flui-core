import { IsNull } from 'typeorm';
import { CatalogAppDefinitionRepository } from './catalog-app-definition.repository';

const OWNER_A = '11111111-1111-1111-1111-111111111111';

function queryBuilder() {
  const wheres: Array<[string, unknown]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['update', 'set', 'delete', 'orderBy']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.where = jest.fn((clause: string, params?: unknown) => {
    wheres.push([clause, params]);
    return qb;
  });
  qb.andWhere = qb.where;
  qb.execute = jest.fn(async () => ({ affected: 0 }));
  qb.getMany = jest.fn(async () => []);
  return { qb, wheres };
}

function build() {
  const builders: Array<ReturnType<typeof queryBuilder>> = [];
  const typeorm = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(false),
    createQueryBuilder: jest.fn(() => {
      const b = queryBuilder();
      builders.push(b);
      return b.qb;
    }),
  };
  return {
    repo: new CatalogAppDefinitionRepository(typeorm as never),
    typeorm,
    builders,
  };
}

describe('CatalogAppDefinitionRepository ownership', () => {
  it('resolves the caller’s own definition before the shared one', async () => {
    const { repo, typeorm } = build();
    const own = { id: 'own', ownerUserId: OWNER_A };
    typeorm.findOne.mockResolvedValueOnce(own);

    await expect(repo.findPublishedBySlug('mine', OWNER_A)).resolves.toBe(own);
    expect(typeorm.findOne).toHaveBeenCalledTimes(1);
    expect(typeorm.findOne.mock.calls[0][0].where).toEqual({
      slug: 'mine',
      isActive: true,
      isPublished: true,
      ownerUserId: OWNER_A,
    });
  });

  it('falls back to the shared definition when the caller has none', async () => {
    const { repo, typeorm } = build();
    const shared = { id: 'shared', ownerUserId: null };
    typeorm.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(shared);

    await expect(repo.findPublishedBySlug('gitea', OWNER_A)).resolves.toBe(
      shared,
    );
    expect(typeorm.findOne.mock.calls[1][0].where).toEqual({
      slug: 'gitea',
      isActive: true,
      isPublished: true,
      ownerUserId: IsNull(),
    });
  });

  it('answers only from the shared catalog without an owner', async () => {
    const { repo, typeorm } = build();
    typeorm.findOne.mockResolvedValueOnce(null);

    await expect(repo.findPublishedBySlug('mine')).resolves.toBeNull();
    expect(typeorm.findOne).toHaveBeenCalledTimes(1);
    expect(typeorm.findOne.mock.calls[0][0].where.ownerUserId).toEqual(
      IsNull(),
    );
  });

  it('looks up a version in the shared catalog unless an owner is named', async () => {
    const { repo, typeorm } = build();
    typeorm.findOne.mockResolvedValue(null);

    await repo.findBySlugAndVersion('gitea', '1.0');
    await repo.findBySlugAndVersion('mine', '1.0', OWNER_A);

    expect(typeorm.findOne.mock.calls[0][0].where.ownerUserId).toEqual(
      IsNull(),
    );
    expect(typeorm.findOne.mock.calls[1][0].where.ownerUserId).toBe(OWNER_A);
  });

  it('matches an existing row of the same owner on upsert', async () => {
    const { repo, typeorm } = build();
    typeorm.findOne.mockResolvedValue(null);
    (typeorm as Record<string, jest.Mock>).create = jest.fn((d) => d);
    (typeorm as Record<string, jest.Mock>).save = jest.fn(async (d) => d);

    await repo.upsert({ slug: 'mine', version: '1', ownerUserId: OWNER_A });

    expect(typeorm.findOne.mock.calls[0][0].where).toEqual({
      slug: 'mine',
      version: '1',
      ownerUserId: OWNER_A,
    });
  });

  it('asks whether a slug belongs to the shared catalog, whatever its version', async () => {
    const { repo, typeorm } = build();
    typeorm.exists.mockResolvedValueOnce(true);

    await expect(repo.hasShared('gitea')).resolves.toBe(true);
    expect(typeorm.exists).toHaveBeenCalledWith({
      where: { slug: 'gitea', ownerUserId: IsNull() },
    });
  });

  it('retires and deletes only the owner’s previous versions', async () => {
    const { repo, builders } = build();

    await repo.cleanupPreviousVersions('mine', '2', OWNER_A);

    expect(builders).toHaveLength(2);
    for (const { wheres } of builders) {
      expect(wheres).toContainEqual([
        '"ownerUserId" = :ownerUserId',
        { ownerUserId: OWNER_A },
      ]);
      expect(wheres.map(([c]) => c)).not.toContain('"ownerUserId" IS NULL');
    }
  });

  it('keeps the seeder’s cleanup inside the shared catalog', async () => {
    const { repo, builders } = build();

    await repo.cleanupPreviousVersions('gitea', '2');

    for (const { wheres } of builders) {
      expect(wheres).toContainEqual(['"ownerUserId" IS NULL', {}]);
    }
  });

  it('lists, suggests clients and offers building blocks from the shared catalog only', async () => {
    const { repo, typeorm, builders } = build();

    await repo.listPublished({ search: 'mine' });
    await repo.listClientsOf('postgresql');
    await repo.listBuildingBlocks();
    await repo.findActiveBySlug('postgresql');

    for (const { wheres } of builders) {
      expect(wheres.map(([c]) => c)).toContain('def.ownerUserId IS NULL');
    }
    expect(typeorm.find.mock.calls[0][0].where.ownerUserId).toEqual(IsNull());
    expect(typeorm.findOne.mock.calls[0][0].where.ownerUserId).toEqual(
      IsNull(),
    );
  });
});
