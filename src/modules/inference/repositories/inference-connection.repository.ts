import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
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
    ownerUserId: string | null;
  }): Promise<InferenceConnectionEntity> {
    const entity = this.repo.create({
      label: data.label,
      base_url: data.baseUrl,
      encrypted_api_key: data.encryptedApiKey,
      models: data.models,
      is_default: data.isDefault,
      owner_user_id: data.ownerUserId,
    });
    return this.repo.save(entity);
  }

  async findAll(): Promise<InferenceConnectionEntity[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  /**
   * Every row this principal is entitled to reach: the installation's, plus her
   * own. Not "every row minus the ones the screen hides" — the filter is the
   * query, so a caller that forgets to filter afterwards cannot leak a row.
   */
  async findUsableBy(userId: string): Promise<InferenceConnectionEntity[]> {
    return this.repo.find({
      where: [{ owner_user_id: IsNull() }, { owner_user_id: userId }],
      order: { created_at: 'DESC' },
    });
  }

  async findById(id: string): Promise<InferenceConnectionEntity | null> {
    return this.repo.findOneBy({ id });
  }

  /**
   * The default this principal should fall onto, own before the installation's.
   *
   * Asked with the owner in hand rather than globally, because a personal row
   * flagged default would otherwise become *everybody's* endpoint — the same
   * leak as guessing the uuid, arriving without an id at all.
   */
  async findDefaultUsableBy(
    userId: string,
  ): Promise<InferenceConnectionEntity | null> {
    return this.repo
      .createQueryBuilder('c')
      .where('c.is_default = true')
      .andWhere('(c.owner_user_id IS NULL OR c.owner_user_id = :userId)', {
        userId,
      })
      .orderBy('c.owner_user_id IS NULL', 'ASC')
      .addOrderBy('c.created_at', 'DESC')
      .getOne();
  }

  /** Scoped to one level: a person's default never unseats the installation's. */
  async clearDefaultFor(ownerUserId: string | null): Promise<void> {
    await this.repo.update(
      {
        is_default: true,
        owner_user_id: ownerUserId ?? IsNull(),
      },
      { is_default: false },
    );
  }

  async updateModels(id: string, models: string[]): Promise<void> {
    await this.repo.update({ id }, { models });
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.repo.delete({ id });
    return result.affected > 0;
  }
}
