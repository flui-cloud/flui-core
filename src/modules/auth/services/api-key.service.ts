import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { ApiKeyEntity } from '../entities/api-key.entity';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeyRepo: Repository<ApiKeyEntity>,
  ) {}

  async generateApiKey(
    name: string,
    userId: string,
    expiresAt?: Date,
    scopes?: string[],
  ): Promise<{ entity: ApiKeyEntity; plaintext: string }> {
    const key = `flui_${crypto.randomUUID()}`;
    const entity = await this.apiKeyRepo.save({
      key,
      name,
      revoked: false,
      userId,
      expiresAt: expiresAt ?? null,
      // Null, not an empty array: "nothing was declared" and "declared as
      // nothing" are read differently by the scope resolver.
      scopes: scopes?.length ? scopes : null,
    });
    return { entity, plaintext: key };
  }

  async findValid(key: string): Promise<ApiKeyEntity | null> {
    const record = await this.apiKeyRepo.findOne({ where: { key } });
    if (!record || record.revoked) return null;
    if (record.expiresAt && record.expiresAt < new Date()) return null;
    return record;
  }

  async listForUser(userId: string): Promise<ApiKeyEntity[]> {
    return this.apiKeyRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      select: [
        'id',
        'name',
        'revoked',
        'createdAt',
        'expiresAt',
        'userId',
        'scopes',
      ],
    });
  }

  async revokeById(id: string, userId: string): Promise<boolean> {
    const result = await this.apiKeyRepo.update(
      { id, userId, revoked: false },
      { revoked: true },
    );
    return (result.affected ?? 0) > 0;
  }

  async revokeByName(name: string): Promise<void> {
    await this.apiKeyRepo.update({ name, revoked: false }, { revoked: true });
  }

  async getActiveKey(name = 'cli-service-account'): Promise<string | null> {
    const record = await this.apiKeyRepo.findOne({
      where: { name, revoked: false },
      order: { createdAt: 'DESC' },
    });
    if (!record) return null;
    if (record.expiresAt && record.expiresAt < new Date()) return null;
    return record.key;
  }
}
