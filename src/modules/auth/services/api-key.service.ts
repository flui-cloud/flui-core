import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { API_KEY_PREFIX, hashApiKey } from '../utils/api-key-hash.util';

/**
 * At most one `lastUsedAt` write per key per minute. **This threshold is the
 * decision, not an implementation detail**: the write sits on the
 * hot path of every authenticated request, so an `UPDATE` per request would
 * make every call to this product pay for a column nobody reads in real time.
 *
 * A minute is also the resolution the column is honest at, and the screen says
 * so — "seen in the last minute" is as precise as this fact ever needs to be.
 */
const TOUCH_INTERVAL_MS = 60_000;

/** Keeps the in-process gate from growing without bound on a busy instance. */
const TOUCH_MEMORY_LIMIT = 5_000;

@Injectable()
export class ApiKeyService {
  /**
   * The first half of the threshold: when this process last wrote each key.
   *
   * In memory because the cheapest `UPDATE` is the one not sent. The second
   * half is the `WHERE` clause in {@link touch}, which keeps the promise true
   * across replicas — without it, N pods mean N writes a minute per key.
   */
  private readonly touchedAt = new Map<string, number>();

  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeyRepo: Repository<ApiKeyEntity>,
  ) {}

  /**
   * Record that this key just authenticated something — at most once a minute.
   *
   * Never awaited by the caller and never allowed to throw: this runs inside
   * authentication, and a database hiccup must cost a missing timestamp, not a
   * refused request.
   */
  touch(id: string): void {
    const now = Date.now();
    const last = this.touchedAt.get(id);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    this.touchedAt.set(id, now);
    if (this.touchedAt.size > TOUCH_MEMORY_LIMIT) {
      for (const [key, at] of this.touchedAt) {
        if (now - at >= TOUCH_INTERVAL_MS) this.touchedAt.delete(key);
      }
    }
    void this.apiKeyRepo
      .createQueryBuilder()
      .update(ApiKeyEntity)
      .set({ lastUsedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere(
        `("lastUsedAt" IS NULL OR "lastUsedAt" < now() - interval '1 minute')`,
      )
      .execute()
      .catch(() => undefined);
  }

  async generateApiKey(
    name: string,
    userId: string,
    expiresAt?: Date,
    scopes?: string[],
  ): Promise<{ entity: ApiKeyEntity; plaintext: string }> {
    const key = `${API_KEY_PREFIX}${crypto.randomUUID()}`;
    // The only moment the credential exists outside the caller's hands. It is
    // returned and forgotten; the row keeps the digest, so nothing on this
    // installation can ever hand it back.
    const entity = await this.apiKeyRepo.save({
      keyHash: hashApiKey(key),
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
    const record = await this.apiKeyRepo.findOne({
      where: { keyHash: hashApiKey(key) },
    });
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
        'lastUsedAt',
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

  /**
   * Close every key this person still holds, and say how many.
   *
   * Revoked, not deleted, and the difference is the whole point: a revoked row
   * still says *there was a credential here and it was closed on this date*,
   * which is what somebody investigating an incident needs. A deleted row says
   * nothing at all, and this table has no foreign key to `users`, so deleting
   * on this path is also how the orphan rows decision 66 had to sweep by hand
   * got there in the first place.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    if (!userId) return 0;
    const result = await this.apiKeyRepo.update(
      { userId, revoked: false },
      { revoked: true },
    );
    return result.affected ?? 0;
  }

  async revokeByName(name: string): Promise<void> {
    await this.apiKeyRepo.update({ name, revoked: false }, { revoked: true });
  }

  /**
   * Adopt a key minted outside this service — today only the one the installer
   * puts in `FLUI_CLI_API_KEY`, which the bootstrap seeder writes at boot.
   *
   * It exists so that the seeder never touches the column directly: there must
   * be exactly one place that knows the stored value is a digest, or the next
   * writer stores a plaintext next to hashes and it authenticates nothing.
   */
  async adoptExternalKey(
    plaintext: string,
    name: string,
    userId: string,
  ): Promise<'seeded' | 'already-present'> {
    const keyHash = hashApiKey(plaintext);
    const exists = await this.apiKeyRepo.findOne({ where: { keyHash } });
    if (exists) return 'already-present';
    await this.apiKeyRepo.save({ keyHash, name, revoked: false, userId });
    return 'seeded';
  }
}
