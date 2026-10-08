import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { UserEntity } from '../entities/user.entity';

export const ACCOUNT_BLOCKED_CODE = 'ACCOUNT_BLOCKED';

const SEEN_EVERY_MS = 15 * 60_000;

/** Refuses every request of a person an administrator blocked. */
export function refuseIfBlocked(user: Pick<UserEntity, 'blockedAt'>): void {
  if (!user.blockedAt) return;
  throw new ForbiddenException({
    statusCode: 403,
    code: ACCOUNT_BLOCKED_CODE,
    message: 'This account has been blocked by an administrator.',
  });
}

/**
 * When a person was last here, written at most every quarter of an hour. It is
 * what lets an idle demo account be removed; a failure to write it is never a
 * reason to fail the request.
 */
export function noteSeen(
  repo: Repository<UserEntity>,
  user: Pick<UserEntity, 'id' | 'lastSeenAt'>,
  now = new Date(),
): void {
  if (
    user.lastSeenAt &&
    now.getTime() - user.lastSeenAt.getTime() < SEEN_EVERY_MS
  ) {
    return;
  }
  user.lastSeenAt = now;
  void Promise.resolve()
    .then(() => repo.update({ id: user.id }, { lastSeenAt: now }))
    .catch(() => undefined);
}
