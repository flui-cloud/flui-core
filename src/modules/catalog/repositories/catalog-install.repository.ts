import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository as TypeOrmRepository, In, IsNull } from 'typeorm';
import { CatalogInstallEntity } from '../entities/catalog-install.entity';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';

@Injectable()
export class CatalogInstallRepository {
  constructor(
    @InjectRepository(CatalogInstallEntity)
    private readonly repository: TypeOrmRepository<CatalogInstallEntity>,
  ) {}

  async create(
    data: Partial<CatalogInstallEntity>,
  ): Promise<CatalogInstallEntity> {
    const entity = this.repository.create(data);
    return this.repository.save(entity);
  }

  async existingResolvedFqdns(hosts: string[]): Promise<string[]> {
    if (hosts.length === 0) return [];
    const rows = await this.repository.find({
      where: { resolvedFqdn: In(hosts), deletedAt: IsNull() },
      select: ['resolvedFqdn'],
    });
    return rows
      .map((r) => r.resolvedFqdn)
      .filter((fqdn): fqdn is string => !!fqdn);
  }

  async findById(id: string): Promise<CatalogInstallEntity | null> {
    return this.repository.findOne({
      where: { id, deletedAt: IsNull() },
      relations: ['definition'],
    });
  }

  async findBySlug(slug: string): Promise<CatalogInstallEntity | null> {
    return this.repository.findOne({
      where: { slug, deletedAt: IsNull() },
      relations: ['definition'],
    });
  }

  async listByCluster(clusterId: string): Promise<CatalogInstallEntity[]> {
    return this.repository.find({
      where: { clusterId, deletedAt: IsNull() },
      relations: ['definition'],
      order: { createdAt: 'DESC' },
    });
  }

  async updateStatus(
    id: string,
    status: CatalogInstallStatus,
    errorMessage?: string,
  ): Promise<void> {
    await this.repository.update({ id }, { status, errorMessage });
  }

  async update(id: string, data: Partial<CatalogInstallEntity>): Promise<void> {
    await this.repository.update({ id }, data);
  }

  async softDelete(id: string): Promise<void> {
    await this.repository.update({ id }, { deletedAt: new Date() });
  }
}
