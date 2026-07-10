import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository as TypeOrmRepository } from 'typeorm';
import { AppResourceEntity } from '../entities/app-resource.entity';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';

@Injectable()
export class AppResourcesRepository {
  constructor(
    @InjectRepository(AppResourceEntity)
    private readonly repository: TypeOrmRepository<AppResourceEntity>,
  ) {}

  async create(data: Partial<AppResourceEntity>): Promise<AppResourceEntity> {
    const entity = this.repository.create(data);
    return this.repository.save(entity);
  }

  async createMany(
    data: Partial<AppResourceEntity>[],
  ): Promise<AppResourceEntity[]> {
    const entities = data.map((d) => this.repository.create(d));
    return this.repository.save(entities);
  }

  async findById(id: string): Promise<AppResourceEntity | null> {
    return this.repository.findOne({ where: { id } });
  }

  async findByApplicationId(
    applicationId: string,
  ): Promise<AppResourceEntity[]> {
    return this.repository.find({
      where: { applicationId },
      order: { kind: 'ASC', name: 'ASC' },
    });
  }

  async findByApplicationIdAndKind(
    applicationId: string,
    kind: ApplicationResourceKind,
  ): Promise<AppResourceEntity[]> {
    return this.repository.find({
      where: { applicationId, kind },
    });
  }

  async findByK8sIdentity(
    applicationId: string,
    kind: ApplicationResourceKind,
    name: string,
    namespace: string,
  ): Promise<AppResourceEntity | null> {
    return this.repository.findOne({
      where: { applicationId, kind, name, namespace },
    });
  }

  async update(
    id: string,
    data: Partial<AppResourceEntity>,
  ): Promise<AppResourceEntity> {
    await this.repository.update(id, data);
    return this.findById(id);
  }

  async deleteByApplicationId(applicationId: string): Promise<void> {
    await this.repository.delete({ applicationId });
  }

  /**
   * Delete every tracking row for one k8s resource identity. Used on each deploy
   * to collapse duplicates before re-recording the desired state, so the drift
   * reconciler never re-applies a stale desiredManifest from an earlier deploy.
   */
  async deleteByK8sIdentity(
    applicationId: string,
    kind: ApplicationResourceKind,
    name: string,
    namespace: string,
  ): Promise<void> {
    await this.repository.delete({ applicationId, kind, name, namespace });
  }

  async delete(id: string): Promise<void> {
    await this.repository.delete(id);
  }
}
