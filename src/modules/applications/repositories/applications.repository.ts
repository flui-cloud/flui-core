import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository as TypeOrmRepository, IsNull } from 'typeorm';
import { ApplicationEntity } from '../entities/application.entity';
import { isPlatformOwned } from '../constants/app-provenance';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationKind } from '../enums/application-kind.enum';

/** Stable code for the refusal below, so a client can recognise it. */
export const PROJECTION_NOT_REMOVABLE_CODE = 'APP_IS_A_PLATFORM_PROJECTION';

@Injectable()
export class ApplicationsRepository {
  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly repository: TypeOrmRepository<ApplicationEntity>,
  ) {}

  async create(data: Partial<ApplicationEntity>): Promise<ApplicationEntity> {
    const entity = this.repository.create(data);
    return this.repository.save(entity);
  }

  async findById(id: string): Promise<ApplicationEntity | null> {
    return this.repository.findOne({
      where: { id, deletedAt: IsNull() },
      relations: ['revisions', 'appResources'],
    });
  }

  async findBySlug(slug: string): Promise<ApplicationEntity | null> {
    return this.repository.findOne({
      where: { slug },
      relations: ['revisions', 'appResources'],
    });
  }

  async findByClusterId(
    clusterId: string,
    filters?: {
      category?: ApplicationCategory;
      kind?: ApplicationKind;
      status?: ApplicationStatus;
    },
  ): Promise<ApplicationEntity[]> {
    const where: Record<string, any> = { clusterId, deletedAt: IsNull() };
    if (filters?.category) {
      where.category = filters.category;
    }
    if (filters?.kind) {
      where.kind = filters.kind;
    }
    if (filters?.status) {
      where.status = filters.status;
    }
    return this.repository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async findByClusterIdAndCategory(
    clusterId: string,
    category: ApplicationCategory,
  ): Promise<ApplicationEntity[]> {
    return this.repository.find({
      where: { clusterId, category, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  async update(
    id: string,
    data: Partial<ApplicationEntity>,
  ): Promise<ApplicationEntity> {
    await this.repository.update(id, data);
    return this.findById(id);
  }

  async updateStatus(id: string, status: ApplicationStatus): Promise<void> {
    await this.repository.update(id, { status });
  }

  async softDelete(id: string): Promise<void> {
    await this.assertNotAProjection(id);
    await this.repository.update(id, {
      deletedAt: new Date(),
      status: ApplicationStatus.DELETED,
    });
  }

  async delete(id: string): Promise<void> {
    await this.assertNotAProjection(id);
    await this.repository.delete(id);
  }

  /**
   * Flui does not own the lifecycle of what it discovered.
   *
   * A row whose provenance says `platform` is a *projection*: the bootstrap put
   * the thing on the cluster, discovery mirrored it here so that logs, metrics,
   * topology and "show the system apps" have something to read. Removing the
   * projection removes the reading, not the thing — the workload keeps running
   * and the next discovery pass writes the row back. So the verb is refused,
   * and refused with the reason that is actually true, instead of with
   * `systemProtected`, a flag Flui sets on itself and could just as well unset.
   *
   * It lives on the repository because that is the one door every removal in the
   * product passes through, and because the fact it refuses is a fact about the
   * row. Cluster teardown does not come through here — the applications rows go
   * with their cluster by `ON DELETE CASCADE`, so nothing that legitimately
   * destroys the underlying thing is blocked.
   */
  private async assertNotAProjection(id: string): Promise<void> {
    const row = await this.repository.findOne({
      where: { id },
      select: { id: true, slug: true, ownerKind: true, ownerRef: true },
    });
    if (!row || !isPlatformOwned(row)) return;
    const declaredBy = row.ownerRef ? ` (declared by ${row.ownerRef})` : '';
    throw new ForbiddenException({
      statusCode: 403,
      code: PROJECTION_NOT_REMOVABLE_CODE,
      message:
        `'${row.slug}' was installed by the platform bootstrap${declaredBy}. ` +
        'Flui mirrors it here so it can be read; it does not own its lifecycle. ' +
        'Remove it where it was declared, not from this list.',
    });
  }

  async findActiveByCluster(clusterId: string): Promise<ApplicationEntity[]> {
    return this.repository.find({
      where: [
        { clusterId, status: ApplicationStatus.RUNNING, deletedAt: IsNull() },
        { clusterId, status: ApplicationStatus.DEGRADED, deletedAt: IsNull() },
      ],
      relations: ['appResources'],
    });
  }

  async existsBySlug(slug: string): Promise<boolean> {
    const count = await this.repository.count({ where: { slug } });
    return count > 0;
  }

  async findAllActive(): Promise<ApplicationEntity[]> {
    return this.repository.find({
      where: [
        { status: ApplicationStatus.RUNNING, deletedAt: IsNull() },
        { status: ApplicationStatus.DEGRADED, deletedAt: IsNull() },
      ],
    });
  }

  /**
   * All GIT_BUILD apps that are active (RUNNING or DEGRADED) and not
   * soft-deleted. Used by the GHCR pull secret refresh job.
   */
  async findActiveGitBuildApps(): Promise<ApplicationEntity[]> {
    return this.repository.find({
      where: [
        {
          sourceType: ApplicationSourceType.GIT_BUILD,
          status: ApplicationStatus.RUNNING,
          deletedAt: IsNull(),
        },
        {
          sourceType: ApplicationSourceType.GIT_BUILD,
          status: ApplicationStatus.DEGRADED,
          deletedAt: IsNull(),
        },
      ],
    });
  }

  /**
   * Apps currently waiting for their GitHub Actions build to finish.
   * Used by the background build watcher to poll GitHub and transition
   * them into PROVISIONING (or FAILED on error / timeout).
   */
  async findAwaitingBuild(): Promise<ApplicationEntity[]> {
    return this.repository.find({
      where: {
        status: ApplicationStatus.AWAITING_BUILD,
        deletedAt: IsNull(),
      },
    });
  }

  async findLiveGitBuildApps(): Promise<ApplicationEntity[]> {
    return (
      this.repository
        .createQueryBuilder('app')
        .where('app.deletedAt IS NULL')
        .andWhere('app.status IN (:...statuses)', {
          statuses: [
            ApplicationStatus.RUNNING,
            ApplicationStatus.DEGRADED,
            ApplicationStatus.UPDATING,
          ],
        })
        .andWhere('app.sourceType = :sourceType', {
          sourceType: ApplicationSourceType.GIT_BUILD,
        })
        .andWhere(`app."sourceConfig"->>'repositoryId' IS NOT NULL`)
        .andWhere('app.userId IS NOT NULL')
        // Only apps that opted into continuous auto-deploy are polled for new
        // commits; the initial deploy runs via the AWAITING_BUILD path, which is
        // not gated here.
        .andWhere('app.deployOnPush = true')
        .getMany()
    );
  }

  /**
   * Applications on a given cluster that were installed via the catalog as a
   * building block with the given slug (e.g. "postgresql", "valkey"). Used by
   * the catalog dependency resolver to offer reusable instances to apps whose
   * manifest declares a `dependencies[]` with `reuseExisting: true`.
   */
  async findBuildingBlocksByCatalogSlug(
    clusterId: string,
    catalogSlug: string,
  ): Promise<ApplicationEntity[]> {
    return this.repository
      .createQueryBuilder('app')
      .where('app.clusterId = :clusterId', { clusterId })
      .andWhere('app.deletedAt IS NULL')
      .andWhere('app.status IN (:...statuses)', {
        statuses: [ApplicationStatus.RUNNING, ApplicationStatus.DEGRADED],
      })
      .andWhere(`app.labels->>'flui.cloud/app-type' = :type`, {
        type: 'building-block',
      })
      .andWhere(`app.labels->>'flui.cloud/catalog-app' = :slug`, {
        slug: catalogSlug,
      })
      .orderBy('app.createdAt', 'DESC')
      .getMany();
  }

  async findByCatalogInstall(installId: string): Promise<ApplicationEntity[]> {
    return this.repository
      .createQueryBuilder('app')
      .where('app.deletedAt IS NULL')
      .andWhere(`app.labels->>'flui.cloud/catalog-install' = :id`, {
        id: installId,
      })
      .orderBy('app.createdAt', 'ASC')
      .getMany();
  }
}
