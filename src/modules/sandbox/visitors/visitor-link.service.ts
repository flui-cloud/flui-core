import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { USER_KIND, UserEntity } from '../../auth/entities/user.entity';
import {
  SandboxVisitorUpgradeEntity,
  VISITOR_UPGRADE_METHOD,
} from '../entities/sandbox-visitor-upgrade.entity';
import { VisitorMergeService } from './visitor-merge.service';

export const VISITOR_LINK_TTL_MS = 15 * 60_000;
export const VISITOR_FLOW_TTL_MS = 10 * 60_000;
const KEEP_AFTER_EXPIRY_MS = 24 * 3_600_000;

export const VISITOR_ONLY_CODE = 'VISITOR_ONLY';
export const VISITOR_LINK_REFUSED_CODE = 'VISITOR_LINK_REFUSED';

export const OUTCOME = {
  UPGRADED: 'upgraded',
  SIGN_IN_AS_EXISTING: 'signin-as-existing',
  REFUSED: 'refused',
  LINKED: 'linked',
} as const;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface LinkIntent {
  nonce: string;
  expiresAt: Date;
}

/**
 * The email way out of a visit: the visitor takes a single-use nonce, registers
 * or signs in normally, and the account it comes back as takes the visit in.
 */
@Injectable()
export class VisitorLinkService {
  constructor(
    @InjectRepository(SandboxVisitorUpgradeEntity)
    private readonly upgrades: Repository<SandboxVisitorUpgradeEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly merge: VisitorMergeService,
  ) {}

  /** The caller as a visitor that may still become an account, or the reason it may not. */
  async visitorOrRefuse(userId: string): Promise<UserEntity> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (user?.kind !== USER_KIND.VISITOR) {
      throw new ConflictException({
        statusCode: 409,
        code: VISITOR_ONLY_CODE,
        message: 'Only a visitor of the demo turns its visit into an account.',
      });
    }
    if (user.blockedAt) throw refused('blocked');
    return user;
  }

  async createIntent(
    visitorUserId: string,
    returnTo: string | null = null,
    now = new Date(),
  ): Promise<LinkIntent> {
    const nonce = newSecret();
    const expiresAt = new Date(now.getTime() + VISITOR_LINK_TTL_MS);
    await this.upgrades.save(
      this.upgrades.create({
        visitorUserId,
        method: VISITOR_UPGRADE_METHOD.EMAIL,
        secretHash: hashSecret(nonce),
        returnTo,
        expiresAt,
      }),
    );
    return { nonce, expiresAt };
  }

  /**
   * Called by the account the visitor signed in as. Idempotent for that
   * account; a blocked visitor is refused the link, not the account.
   */
  async link(
    callerUserId: string,
    nonce: string,
    now = new Date(),
  ): Promise<{ outcome: 'linked'; returnTo: string | null }> {
    const caller = await this.users.findOne({ where: { id: callerUserId } });
    if (!caller) throw new NotFoundException('You are not known here.');
    const row = await this.upgrades.findOne({
      where: {
        secretHash: hashSecret(nonce),
        method: VISITOR_UPGRADE_METHOD.EMAIL,
      },
    });
    if (!row) throw new NotFoundException('This link is not known.');
    if (row.outcome === OUTCOME.LINKED && row.linkedUserId === caller.id) {
      return { outcome: OUTCOME.LINKED, returnTo: row.returnTo };
    }
    if (row.claimedAt || row.outcome) {
      throw new GoneException('This link has already been used.');
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new GoneException('This link has expired.');
    }
    if (caller.kind === USER_KIND.VISITOR || caller.id === row.visitorUserId) {
      throw refused('not-an-account');
    }
    const claimed = await this.upgrades.update(
      { id: row.id, claimedAt: IsNull() },
      { claimedAt: now },
    );
    if (!claimed.affected) {
      throw new GoneException('This link has already been used.');
    }

    try {
      const result = await this.merge.fold(
        row.visitorUserId,
        caller,
        'email',
        now,
      );
      if (!result.done) {
        await this.upgrades.update(
          { id: row.id },
          { outcome: OUTCOME.REFUSED, linkedUserId: caller.id },
        );
        throw result.reason === 'blocked'
          ? refused('blocked')
          : new GoneException('This visit has already ended.');
      }
      await this.upgrades.update(
        { id: row.id },
        { outcome: OUTCOME.LINKED, linkedUserId: caller.id },
      );
      return { outcome: OUTCOME.LINKED, returnTo: row.returnTo };
    } catch (error) {
      const settled = await this.upgrades.findOne({ where: { id: row.id } });
      if (!settled?.outcome) {
        await this.upgrades.update({ id: row.id }, { claimedAt: null });
      }
      throw error;
    }
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const result = await this.upgrades.delete({
      expiresAt: LessThan(new Date(now.getTime() - KEEP_AFTER_EXPIRY_MS)),
    });
    return result.affected ?? 0;
  }
}

export function refused(reason: string): ConflictException {
  const messages: Record<string, string> = {
    blocked: 'This visit cannot be added to an account.',
    'not-an-account':
      'Sign in with the account the visit should be added to, then try again.',
  };
  return new ConflictException({
    statusCode: 409,
    code: VISITOR_LINK_REFUSED_CODE,
    reason,
    message: messages[reason] ?? 'This visit cannot be added to an account.',
  });
}
