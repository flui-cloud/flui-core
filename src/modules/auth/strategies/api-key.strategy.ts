import { Injectable, UnauthorizedException } from '@nestjs/common';
import { noteSeen, refuseIfBlocked } from '../utils/user-presence.util';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ApiKeyService } from '../services/api-key.service';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { serviceIdentityFor } from '../constants/service-identities';
import { SandboxVisitorEntity } from '../../sandbox/entities/sandbox-visitor.entity';
import { visitorGone } from '../utils/visitor-gone.util';

// `api_keys.userId` is a varchar, `users.id` a uuid: handing Postgres anything
// else answers 500 instead of 401. The sentinel written by configure-auth-mode
// hit exactly that, so the key it mints has never reached the branch below.
const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key row that authenticated the request, parked on the request object.
 *
 * Deliberately not a field on {@link AuthenticatedUser}: `me()` and
 * `oidcSession()` return `req.user` verbatim, so anything added there is
 * inherited for good by every consumer of the type and shows up on two routes
 * that have no business carrying it. A symbol on the request is read by the one
 * handler that needs it and by nothing else.
 */
export const CURRENT_API_KEY_ID = Symbol('currentApiKeyId');

/** Whichever `id` the row had, and null for anything not authenticated by a key. */
export interface RequestWithApiKey {
  [CURRENT_API_KEY_ID]?: string;
}

@Injectable()
export class ApiKeyStrategy {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(SandboxVisitorEntity)
    private readonly visitors: Repository<SandboxVisitorEntity>,
  ) {}

  async validate(key: string): Promise<AuthenticatedUser> {
    return (await this.validateWithRecord(key)).user;
  }

  /**
   * The principal plus the id of the row it came from.
   *
   * The id was always in hand here and always thrown away. It is the only way
   * to say which of somebody's keys is serving the request they are making —
   * and without it the list has to guess, which after `/sandbox/resume` it gets
   * wrong: that flow mints `sandbox-resume-<ns>` alongside `sandbox-<ns>`, so a
   * guest holds two rows and either one may be the live one.
   */
  async validateWithRecord(
    key: string,
  ): Promise<{ user: AuthenticatedUser; keyId: string }> {
    const record = await this.apiKeyService.findValid(key);
    if (!record) {
      if (await this.wasRemovedVisitorKey(key)) throw visitorGone();
      throw new UnauthorizedException('Invalid or revoked API key');
    }
    // Behind a one-write-per-minute threshold and never awaited: see
    // `ApiKeyService.touch`. Recorded for a key that authenticates, whether or
    // not the principal behind it still resolves — a key whose owner is gone is
    // refused below, and "something is still presenting it" is exactly the fact
    // whoever comes to clean up needs.
    this.apiKeyService.touch(record.id);

    if (record.userId && USER_ID.test(record.userId)) {
      const user = await this.userRepo.findOne({
        where: { id: record.userId },
      });
      if (user) {
        refuseIfBlocked(user);
        noteSeen(this.userRepo, user);
        return {
          user: {
            userId: user.id,
            email: user.email,
            roles: {},
            role: user.role ?? IdentityRole.USER,
            isAdmin: user.isAdmin,
            scopes: record.scopes ?? undefined,
            applicationIds: record.applicationIds ?? undefined,
            projectIds: record.projectIds ?? undefined,
          },
          keyId: record.id,
        };
      }
    }

    // No user behind the key. Either it is one of the declared service
    // identities, or the person it belonged to is gone — and a credential whose
    // owner is gone must stop working, not inherit the platform.
    const identity = serviceIdentityFor(record);
    if (!identity) {
      if (await this.wasVisitor(record.userId)) throw visitorGone();
      throw new UnauthorizedException(
        'API key is not bound to an existing user',
      );
    }

    return {
      user: {
        userId: identity.id,
        email: identity.email,
        roles: {},
        role: identity.role,
        isAdmin: identity.isAdmin,
        scopes: narrowToIdentity(record.scopes, identity.scopes),
        applicationIds: record.applicationIds ?? undefined,
        projectIds: record.projectIds ?? undefined,
      },
      keyId: record.id,
    };
  }

  /** A key of a visitor that was removed: revoked with it, and kept so it can say so. */
  private async wasRemovedVisitorKey(key: string): Promise<boolean> {
    const record = await this.apiKeyService.findAny(key);
    if (!record?.userId || !USER_ID.test(record.userId)) return false;
    return this.visitors.exists({
      where: { userId: record.userId, removedAt: Not(IsNull()) },
    });
  }

  /** The person behind the key is gone, and it was a visitor Flui made. */
  private async wasVisitor(userId: string | null): Promise<boolean> {
    if (!userId || !USER_ID.test(userId)) return false;
    return this.visitors.exists({ where: { userId } });
  }
}

/** A key never carries more than its identity declares; declaring nothing narrows nothing. */
function narrowToIdentity(
  onKey: string[] | null,
  declared: string[],
): string[] | undefined {
  if (!onKey?.length) return declared.length ? declared : undefined;
  if (!declared.length) return onKey;
  return onKey.filter((s) => declared.includes(s));
}
