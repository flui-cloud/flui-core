import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IdentityEmailDeliveryEntity } from '../entities/identity-email-delivery.entity';

/** How long a sent message is remembered, so a retry within it is not sent again. */
export const IDENTITY_DEDUPE_TTL_MS = 15 * 60_000;

/**
 * How long a claim may stay in flight before another attempt may take it over.
 * Longer than the identity provider's own 5-second wait, so a send still
 * running is never doubled, and short enough that a crashed copy of the API
 * does not hold a message back for long.
 */
export const IDENTITY_INFLIGHT_STALE_MS = 60_000;

export type IdentityEmailClaim = 'claimed' | 'duplicate' | 'in_flight';

/** Keyed so the stored value cannot be guessed back from a short code. */
export function identityBodyHash(raw: string | Buffer, key: string): string {
  return createHmac('sha256', key).update(raw).digest('hex');
}

/**
 * At-most-once per message body within a short window, across every copy of
 * the API: the claim is one conditional upsert, so two concurrent retries
 * cannot both win it.
 */
@Injectable()
export class IdentityEmailDedupeService {
  constructor(
    @InjectRepository(IdentityEmailDeliveryEntity)
    private readonly repo: Repository<IdentityEmailDeliveryEntity>,
  ) {}

  async claim(
    hash: string,
    now: Date = new Date(),
  ): Promise<IdentityEmailClaim> {
    const expired = new Date(now.getTime() - IDENTITY_DEDUPE_TTL_MS);
    const stale = new Date(now.getTime() - IDENTITY_INFLIGHT_STALE_MS);
    const won = await this.repo.query(
      `INSERT INTO "identity_email_deliveries" ("bodyHash", "state", "duplicates", "updatedAt")
       VALUES ($1, 'sending', 0, $2)
       ON CONFLICT ("bodyHash") DO UPDATE SET
         "state" = 'sending',
         "duplicates" = 0,
         "updatedAt" = excluded."updatedAt"
       WHERE "identity_email_deliveries"."updatedAt" < $3
          OR ("identity_email_deliveries"."state" = 'sending'
              AND "identity_email_deliveries"."updatedAt" < $4)
       RETURNING "bodyHash"`,
      [hash, now, expired, stale],
    );
    if (Array.isArray(won) && won.length > 0) return 'claimed';

    const row = await this.repo.findOne({ where: { bodyHash: hash } });
    if (row?.state === 'sent') {
      await this.repo.increment({ bodyHash: hash }, 'duplicates', 1);
      return 'duplicate';
    }
    return 'in_flight';
  }

  async sent(hash: string, now: Date = new Date()): Promise<void> {
    await this.repo.update(
      { bodyHash: hash },
      { state: 'sent', updatedAt: now },
    );
  }

  async release(hash: string): Promise<void> {
    await this.repo.delete({ bodyHash: hash, state: 'sending' });
  }

  async purge(now: Date = new Date()): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .delete()
      .where('"updatedAt" < :cutoff', {
        cutoff: new Date(now.getTime() - IDENTITY_DEDUPE_TTL_MS),
      })
      .execute();
  }
}
