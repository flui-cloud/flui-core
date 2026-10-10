import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository as TypeOrmRepository } from 'typeorm';
import { validate as isUuid } from 'uuid';
import { RepositoryEntity, GitProvider } from '../entities/repository.entity';

/**
 * Whether an application owned by `userId` may use this repository: its row
 * carries the GitHub credential of whoever connected it.
 *
 * An application created by a service identity records no owner, so it may
 * reach only a repository connected by a service identity, never a person's.
 */
export function ownsRepository(
  row: Pick<RepositoryEntity, 'userId'>,
  userId: string | null | undefined,
): boolean {
  return userId ? row.userId === userId : !isUuid(row.userId);
}

@Injectable()
export class RepositoriesRepository {
  constructor(
    @InjectRepository(RepositoryEntity)
    private readonly repository: TypeOrmRepository<RepositoryEntity>,
  ) {}

  async create(data: Partial<RepositoryEntity>): Promise<RepositoryEntity> {
    const entity = this.repository.create(data);
    return this.repository.save(entity);
  }

  async findById(id: string): Promise<RepositoryEntity | null> {
    return this.repository.findOne({ where: { id } });
  }

  /** The repository an application links to — see `ownsRepository`. */
  async findOwnedById(
    id: string,
    userId: string | null | undefined,
  ): Promise<RepositoryEntity | null> {
    const row = await this.repository.findOne({ where: { id } });
    return row && ownsRepository(row, userId) ? row : null;
  }

  async findByUserIdAndFullName(
    userId: string,
    repositoryFullName: string,
  ): Promise<RepositoryEntity | null> {
    return this.repository.findOne({
      where: { userId, repositoryFullName },
    });
  }

  async findByUserId(userId: string): Promise<RepositoryEntity[]> {
    return this.repository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async findByUserIdAndProvider(
    userId: string,
    provider: GitProvider,
  ): Promise<RepositoryEntity[]> {
    return this.repository.find({
      where: { userId, provider },
      order: { createdAt: 'DESC' },
    });
  }

  async update(
    id: string,
    data: Partial<RepositoryEntity>,
  ): Promise<RepositoryEntity> {
    await this.repository.update(id, data);
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.repository.delete(id);
  }

  async updateLastSyncAt(id: string): Promise<void> {
    await this.repository.update(id, { lastSyncAt: new Date() });
  }

  async findWithWebhookEnabled(userId: string): Promise<RepositoryEntity[]> {
    return this.repository.find({
      where: { userId, webhookActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findWithAutoDeployEnabled(userId: string): Promise<RepositoryEntity[]> {
    return this.repository.find({
      where: { userId, autoDeployEnabled: true },
      order: { createdAt: 'DESC' },
    });
  }
}
