import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InferenceConnectionEntity } from '../entities/inference-connection.entity';

@Injectable()
export class InferenceConnectionRepository {
  constructor(
    @InjectRepository(InferenceConnectionEntity)
    private readonly repo: Repository<InferenceConnectionEntity>,
  ) {}

  async create(data: {
    label: string;
    baseUrl: string;
    encryptedApiKey: string;
    models: string[];
    isDefault: boolean;
  }): Promise<InferenceConnectionEntity> {
    const entity = this.repo.create({
      label: data.label,
      base_url: data.baseUrl,
      encrypted_api_key: data.encryptedApiKey,
      models: data.models,
      is_default: data.isDefault,
    });
    return this.repo.save(entity);
  }

  async findAll(): Promise<InferenceConnectionEntity[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  async findById(id: string): Promise<InferenceConnectionEntity | null> {
    return this.repo.findOneBy({ id });
  }

  async findDefault(): Promise<InferenceConnectionEntity | null> {
    return this.repo.findOneBy({ is_default: true });
  }

  async clearDefault(): Promise<void> {
    await this.repo.update({ is_default: true }, { is_default: false });
  }

  async updateModels(id: string, models: string[]): Promise<void> {
    await this.repo.update({ id }, { models });
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.repo.delete({ id });
    return result.affected > 0;
  }
}
