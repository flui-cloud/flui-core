import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { CrashDiagnosisEntity } from '../entities/crash-diagnosis.entity';
import { CrashCategory } from '../enums/crash-category.enum';
import { CrashDiagnosisStatusFilter } from '../enums/crash-diagnosis-status-filter.enum';

export interface FindByApplicationOptions {
  status?: CrashDiagnosisStatusFilter;
  limit?: number;
  offset?: number;
}

@Injectable()
export class CrashDiagnosesRepository {
  constructor(
    @InjectRepository(CrashDiagnosisEntity)
    private readonly repo: Repository<CrashDiagnosisEntity>,
  ) {}

  create(data: Partial<CrashDiagnosisEntity>): Promise<CrashDiagnosisEntity> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  findById(id: string): Promise<CrashDiagnosisEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByApplication(
    applicationId: string,
    opts: FindByApplicationOptions = {},
  ): Promise<CrashDiagnosisEntity[]> {
    const {
      status = CrashDiagnosisStatusFilter.ALL,
      limit = 50,
      offset = 0,
    } = opts;
    const where: Record<string, unknown> = { applicationId };
    if (status === CrashDiagnosisStatusFilter.UNRESOLVED) {
      where.resolvedAt = IsNull();
    } else if (status === CrashDiagnosisStatusFilter.RESOLVED) {
      where.resolvedAt = Not(IsNull());
    }
    return this.repo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  findLatestForPod(
    applicationId: string,
    podName: string,
  ): Promise<CrashDiagnosisEntity | null> {
    return this.repo.findOne({
      where: { applicationId, podName },
      order: { createdAt: 'DESC' },
    });
  }

  async markResolved(id: string): Promise<void> {
    await this.repo.update(id, { resolvedAt: new Date() });
  }

  async markResolvedForContainer(
    applicationId: string,
    containerName: string | null,
    category: CrashCategory,
  ): Promise<number> {
    const qb = this.repo
      .createQueryBuilder()
      .update(CrashDiagnosisEntity)
      .set({ resolvedAt: () => 'NOW()' })
      .where('applicationId = :applicationId', { applicationId })
      .andWhere('category = :category', { category })
      .andWhere('resolvedAt IS NULL');
    if (containerName === null) {
      qb.andWhere('containerName IS NULL');
    } else {
      qb.andWhere('containerName = :containerName', { containerName });
    }
    const result = await qb.execute();
    return result.affected ?? 0;
  }
}
