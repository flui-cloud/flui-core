import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';
import { createHmac } from 'node:crypto';
import { IdentityEmailSendEntity } from '../entities/identity-email-send.entity';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export interface IdentityEmailLimits {
  /** Mail one address may receive in a day. */
  perRecipientPerDay: number;
  /** Mail the identity provider may send in an hour, to anyone. 0 means no ceiling. */
  perHour: number;
}

export type IdentityEmailLimit = 'recipient' | 'hourly';

function whole(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function identityEmailLimits(
  env: NodeJS.ProcessEnv = process.env,
): IdentityEmailLimits {
  return {
    perRecipientPerDay: whole(env.IDENTITY_EMAIL_MAX_PER_RECIPIENT_PER_DAY, 20),
    perHour: whole(env.IDENTITY_EMAIL_MAX_PER_HOUR, 0),
  };
}

/** Keyed, so the table never holds an address nor anything that leads back to one. */
export function identityRecipientHash(email: string, key: string): string {
  return createHmac('sha256', key)
    .update(email.trim().toLowerCase())
    .digest('hex');
}

/**
 * Ceilings on sign-in mail. A sign-up form sends a verification to whatever
 * address is typed in, so without them the identity provider is a way to mail
 * strangers from Flui's sending domain.
 */
@Injectable()
export class IdentityEmailLimitService {
  constructor(
    @InjectRepository(IdentityEmailSendEntity)
    private readonly sends: Repository<IdentityEmailSendEntity>,
  ) {}

  async reached(
    recipientHash: string,
    now: Date = new Date(),
    limits: IdentityEmailLimits = identityEmailLimits(),
  ): Promise<IdentityEmailLimit | null> {
    const today = await this.sends.count({
      where: {
        recipientHash,
        sentAt: MoreThan(new Date(now.getTime() - DAY_MS)),
      },
    });
    if (today >= limits.perRecipientPerDay) return 'recipient';
    if (limits.perHour > 0) {
      const lastHour = await this.sends.count({
        where: { sentAt: MoreThan(new Date(now.getTime() - HOUR_MS)) },
      });
      if (lastHour >= limits.perHour) return 'hourly';
    }
    return null;
  }

  async record(recipientHash: string, now: Date = new Date()): Promise<void> {
    await this.sends.insert({ recipientHash, sentAt: now });
  }

  async purge(now: Date = new Date()): Promise<void> {
    await this.sends.delete({
      sentAt: LessThan(new Date(now.getTime() - DAY_MS)),
    });
  }
}
