import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import {
  ApplicationServiceEntity,
  AttachedServiceStatus,
} from '../entities/application-service.entity';
import { LinkedEnvSpec } from '../attached-service-env.core';

export interface DesiredAttachment {
  name: string;
  block: string;
  envSpec: LinkedEnvSpec[];
  resources: Record<string, unknown> | null;
}

/** sha256 of what the manifest asks for — the only definition of "must reconcile". */
export function desiredHashOf(desired: DesiredAttachment): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        block: desired.block,
        env: desired.envSpec,
        resources: desired.resources ?? null,
      }),
    )
    .digest('hex');
}

@Injectable()
export class ApplicationServicesRepository {
  constructor(
    @InjectRepository(ApplicationServiceEntity)
    private readonly repo: Repository<ApplicationServiceEntity>,
  ) {}

  async listByApplication(
    applicationId: string,
  ): Promise<ApplicationServiceEntity[]> {
    return this.repo.find({
      where: { applicationId, deletedAt: IsNull() },
      order: { name: 'ASC' },
    });
  }

  async findById(id: string): Promise<ApplicationServiceEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Create or refresh the row for one declared service, in ONE statement.
   *
   * Two pushes of the same branch land here at the same time; the partial
   * unique index is what decides between them, and `ON CONFLICT … DO UPDATE`
   * is what makes the loser refresh the row rather than fail the deploy.
   * Only what the manifest owns is written — status, lock and the block's ids
   * belong to the reconciler and are left exactly as they are.
   */
  async upsertDesired(
    applicationId: string,
    desired: DesiredAttachment,
  ): Promise<ApplicationServiceEntity> {
    const hash = desiredHashOf(desired);
    await this.repo.query(
      `INSERT INTO "application_services"
         ("applicationId", "name", "block", "scope", "envSpec", "resources", "desiredHash", "status")
       VALUES ($1, $2, $3, 'app', $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT ("applicationId", "name") WHERE "deletedAt" IS NULL
       DO UPDATE SET
         "block" = excluded."block",
         "envSpec" = excluded."envSpec",
         "resources" = excluded."resources",
         "desiredHash" = excluded."desiredHash",
         "updatedAt" = now()`,
      [
        applicationId,
        desired.name,
        desired.block,
        JSON.stringify(desired.envSpec),
        desired.resources === null ? null : JSON.stringify(desired.resources),
        hash,
        AttachedServiceStatus.PENDING,
      ],
    );
    const row = await this.repo.findOne({
      where: { applicationId, name: desired.name, deletedAt: IsNull() },
    });
    if (!row) {
      throw new Error(
        `attached service ${desired.name} of ${applicationId} vanished right after its upsert`,
      );
    }
    return row;
  }

  /**
   * Take the row for the duration of a provisioning run.
   *
   * A conditional UPDATE, not a transaction: installing a block takes minutes,
   * and a transaction held that long is a different failure. The expiry is what
   * survives an API restart in the middle of one — the row becomes takeable
   * again instead of staying locked forever.
   */
  async acquireLock(id: string, ttlMs: number): Promise<string | null> {
    const token = crypto.randomUUID();
    const result: { affected?: number } = await this.repo
      .createQueryBuilder()
      .update(ApplicationServiceEntity)
      .set({
        lockToken: token,
        lockExpiresAt: new Date(Date.now() + ttlMs),
        status: AttachedServiceStatus.PROVISIONING,
      })
      .where('id = :id', { id })
      .andWhere('("lockExpiresAt" IS NULL OR "lockExpiresAt" < now())')
      .execute();
    return result.affected === 1 ? token : null;
  }

  async releaseLock(id: string, token: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(ApplicationServiceEntity)
      .set({ lockToken: null, lockExpiresAt: null })
      .where('id = :id AND "lockToken" = :token', { id, token })
      .execute();
  }

  async markReady(
    id: string,
    patch: {
      catalogInstallId: string | null;
      bbApplicationId: string | null;
      appliedHash: string;
    },
  ): Promise<void> {
    await this.repo.update(id, {
      ...patch,
      status: AttachedServiceStatus.READY,
      statusReason: null,
    });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.repo.update(id, {
      status: AttachedServiceStatus.FAILED,
      statusReason: reason.slice(0, 2000),
    });
  }

  async markDetached(id: string): Promise<void> {
    await this.repo.update(id, {
      status: AttachedServiceStatus.DETACHED,
      deletedAt: new Date(),
    });
  }

  /** Rows the manifest stopped declaring — soft-deleted so the sweep can act on them. */
  async retire(id: string): Promise<void> {
    await this.repo.update(id, { deletedAt: new Date() });
  }
}
