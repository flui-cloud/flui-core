import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository as TypeOrmRepository, In, IsNull } from 'typeorm';
import { CatalogAppDefinitionEntity } from '../entities/catalog-app-definition.entity';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';

const SHARED_DEF = 'def.ownerUserId IS NULL';
const SHARED_ROW = '"ownerUserId" IS NULL';
const NOT_REFERENCED_BY_INSTALLS = `id NOT IN (SELECT "catalogAppDefinitionId" FROM catalog_installs)`;

@Injectable()
export class CatalogAppDefinitionRepository {
  constructor(
    @InjectRepository(CatalogAppDefinitionEntity)
    private readonly repository: TypeOrmRepository<CatalogAppDefinitionEntity>,
  ) {}

  async findBySlugAndVersion(
    slug: string,
    version: string,
    ownerUserId: string | null = null,
  ): Promise<CatalogAppDefinitionEntity | null> {
    return this.repository.findOne({
      where: { slug, version, ownerUserId: ownerUserId ?? IsNull() },
    });
  }

  async hasShared(slug: string): Promise<boolean> {
    return this.repository.exists({
      where: { slug, ownerUserId: IsNull() },
    });
  }

  async findActiveBySlug(
    slug: string,
  ): Promise<CatalogAppDefinitionEntity | null> {
    return this.repository.findOne({
      where: { slug, isActive: true, ownerUserId: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * The caller's own definition for the slug when it has one, else the shared
   * one. Without an owner only the shared catalog answers.
   */
  async findPublishedBySlug(
    slug: string,
    ownerUserId?: string | null,
  ): Promise<CatalogAppDefinitionEntity | null> {
    if (ownerUserId) {
      const own = await this.repository.findOne({
        where: { slug, isActive: true, isPublished: true, ownerUserId },
        order: { createdAt: 'DESC' },
      });
      if (own) return own;
    }
    return this.repository.findOne({
      where: { slug, isActive: true, isPublished: true, ownerUserId: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: string): Promise<CatalogAppDefinitionEntity | null> {
    return this.repository.findOne({ where: { id } });
  }

  async listPublished(filters?: {
    category?: string;
    appKind?: ApplicationKind;
    tags?: string[];
    search?: string;
  }): Promise<CatalogAppDefinitionEntity[]> {
    const qb = this.repository
      .createQueryBuilder('def')
      .where('def.isActive = :isActive', { isActive: true })
      .andWhere('def.isPublished = :isPublished', { isPublished: true })
      .andWhere(SHARED_DEF)
      .andWhere('def.appType IN (:...types)', {
        types: [
          CatalogAppType.STANDALONE,
          CatalogAppType.BUILDING_BLOCK,
          CatalogAppType.COMPOSED,
        ],
      });

    if (filters?.category) {
      qb.andWhere('def.category = :category', { category: filters.category });
    }
    if (filters?.appKind) {
      qb.andWhere('def.appKind = :appKind', { appKind: filters.appKind });
    }
    if (filters?.search) {
      const q = `%${filters.search.toLowerCase()}%`;
      qb.andWhere(
        "(LOWER(def.name) LIKE :q OR LOWER(def.slug) LIKE :q OR LOWER(COALESCE(def.description, '')) LIKE :q)",
        { q },
      );
    }
    qb.orderBy('def.name', 'ASC');
    const results = await qb.getMany();
    if (!filters?.tags?.length) return results;
    return results.filter((r) => filters.tags.every((t) => r.tags.includes(t)));
  }

  async listClientsOf(
    buildingBlockSlug: string,
  ): Promise<CatalogAppDefinitionEntity[]> {
    return this.repository
      .createQueryBuilder('def')
      .where('def.isActive = :isActive', { isActive: true })
      .andWhere('def.isPublished = :isPublished', { isPublished: true })
      .andWhere(SHARED_DEF)
      .andWhere(':bb = ANY(def.clientFor)', { bb: buildingBlockSlug })
      .orderBy('def.name', 'ASC')
      .getMany();
  }

  async listBuildingBlocks(): Promise<CatalogAppDefinitionEntity[]> {
    return this.repository.find({
      where: {
        isActive: true,
        appType: CatalogAppType.BUILDING_BLOCK,
        ownerUserId: IsNull(),
      },
      order: { name: 'ASC' },
    });
  }

  async updateById(
    id: string,
    data: Partial<CatalogAppDefinitionEntity>,
  ): Promise<void> {
    await this.repository.update(id, data);
  }

  async upsert(
    data: Partial<CatalogAppDefinitionEntity>,
  ): Promise<CatalogAppDefinitionEntity> {
    const existing = await this.findBySlugAndVersion(
      data.slug,
      data.version,
      data.ownerUserId ?? null,
    );
    if (existing) {
      Object.assign(existing, data);
      return this.repository.save(existing);
    }
    const entity = this.repository.create(data);
    return this.repository.save(entity);
  }

  /**
   * After upserting a new version of a catalog app (e.g. bumping gitea
   * from 1.26 → 28.4), remove or retire all previous rows of the same slug so
   * the public listing only returns the current version.
   *
   * Two-step to respect the FK constraint on catalog_installs:
   *   1. Deactivate every non-current row (isActive=false). Always safe —
   *      just an UPDATE.
   *   2. Delete the rows that are not referenced by any live install.
   *      Rows still referenced are kept in DB (isActive=false) so the install
   *      row keeps a valid FK target, but they no longer appear in catalog
   *      listings.
   *
   * Only the rows of the same owner are touched: the shared catalog's when
   * `ownerUserId` is null, that user's own definitions otherwise.
   */
  async cleanupPreviousVersions(
    slug: string,
    keepVersion: string,
    ownerUserId: string | null = null,
  ): Promise<{ deactivated: number; deleted: number }> {
    const owner = ownerUserId
      ? { clause: '"ownerUserId" = :ownerUserId', params: { ownerUserId } }
      : { clause: SHARED_ROW, params: {} };
    const deactivateResult = await this.repository
      .createQueryBuilder()
      .update()
      .set({ isActive: false })
      .where('slug = :slug', { slug })
      .andWhere(owner.clause, owner.params)
      .andWhere('version != :keepVersion', { keepVersion })
      .andWhere('isActive = :isActive', { isActive: true })
      .execute();

    // NB: do NOT filter the subquery by `deletedAt IS NULL`. The FK on
    // catalog_installs.catalogAppDefinitionId is enforced regardless of soft
    // delete — a row that physically exists in catalog_installs blocks the
    // parent delete even if its deletedAt is set. Including soft-deleted
    // installs in the exclusion set is the only safe FK-aware filter.
    const deleteResult = await this.repository
      .createQueryBuilder()
      .delete()
      .where('slug = :slug', { slug })
      .andWhere(owner.clause, owner.params)
      .andWhere('version != :keepVersion', { keepVersion })
      .andWhere(NOT_REFERENCED_BY_INSTALLS)
      .execute();

    return {
      deactivated: deactivateResult.affected ?? 0,
      deleted: deleteResult.affected ?? 0,
    };
  }

  /**
   * Retires every shared definition whose slug no seed file carries any more,
   * with the same FK-aware two steps as `cleanupPreviousVersions`: hidden from
   * every listing and lookup, deleted only when no install row points at it.
   */
  async retireSharedSlugsNotIn(
    keepSlugs: string[],
  ): Promise<{ retiredSlugs: string[]; deleted: number }> {
    if (!keepSlugs.length) return { retiredSlugs: [], deleted: 0 };

    const stale = await this.repository
      .createQueryBuilder('def')
      .select('DISTINCT def.slug', 'slug')
      .where(SHARED_DEF)
      .andWhere('def.slug NOT IN (:...keepSlugs)', { keepSlugs })
      .andWhere('(def.isActive = true OR def.isPublished = true)')
      .getRawMany<{ slug: string }>();

    await this.repository
      .createQueryBuilder()
      .update()
      .set({ isActive: false, isPublished: false })
      .where(SHARED_ROW)
      .andWhere('slug NOT IN (:...keepSlugs)', { keepSlugs })
      .execute();

    const deleteResult = await this.repository
      .createQueryBuilder()
      .delete()
      .where(SHARED_ROW)
      .andWhere('slug NOT IN (:...keepSlugs)', { keepSlugs })
      .andWhere(NOT_REFERENCED_BY_INSTALLS)
      .execute();

    return {
      retiredSlugs: stale.map((r) => r.slug),
      deleted: deleteResult.affected ?? 0,
    };
  }

  async findByIds(ids: string[]): Promise<CatalogAppDefinitionEntity[]> {
    if (!ids.length) return [];
    return this.repository.find({ where: { id: In(ids) } });
  }
}
