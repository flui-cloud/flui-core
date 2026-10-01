import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupJobStatus } from '../enums/backup-job.enum';

@Injectable()
export class BackupJobRepository {
  constructor(
    @InjectRepository(BackupJobEntity)
    private readonly repo: Repository<BackupJobEntity>,
  ) {}

  create(data: Partial<BackupJobEntity>): BackupJobEntity {
    return this.repo.create(data);
  }

  save(entity: BackupJobEntity): Promise<BackupJobEntity> {
    return this.repo.save(entity);
  }

  findById(id: string): Promise<BackupJobEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByPolicy(policyId: string, take?: number): Promise<BackupJobEntity[]> {
    return this.repo.find({
      where: { policyId },
      order: { createdAt: 'DESC' },
      ...(take ? { take } : {}),
    });
  }

  findLastCompletedByPolicy(policyId: string): Promise<BackupJobEntity | null> {
    return this.repo.findOne({
      where: { policyId, status: BackupJobStatus.COMPLETED },
      order: { finishedAt: 'DESC' },
    });
  }

  findByCluster(clusterId: string): Promise<BackupJobEntity[]> {
    return this.repo.find({
      where: { clusterId },
      order: { createdAt: 'DESC' },
    });
  }

  update(id: string, patch: Partial<BackupJobEntity>): Promise<unknown> {
    return this.repo.update(id, patch);
  }
}
