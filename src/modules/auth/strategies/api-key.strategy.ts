import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKeyService } from '../services/api-key.service';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { serviceIdentityFor } from '../constants/service-identities';

// `api_keys.userId` is a varchar, `users.id` a uuid: handing Postgres anything
// else answers 500 instead of 401. The sentinel written by configure-auth-mode
// hit exactly that, so the key it mints has never reached the branch below.
const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ApiKeyStrategy {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async validate(key: string): Promise<AuthenticatedUser> {
    const record = await this.apiKeyService.findValid(key);
    if (!record) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    if (record.userId && USER_ID.test(record.userId)) {
      const user = await this.userRepo.findOne({
        where: { id: record.userId },
      });
      if (user) {
        return {
          userId: user.id,
          email: user.email,
          roles: {},
          role: user.role ?? IdentityRole.USER,
          isAdmin: user.isAdmin,
          scopes: record.scopes ?? undefined,
        };
      }
    }

    // No user behind the key. Either it is one of the declared service
    // identities, or the person it belonged to is gone — and a credential whose
    // owner is gone must stop working, not inherit the platform.
    const identity = serviceIdentityFor(record);
    if (!identity) {
      throw new UnauthorizedException(
        'API key is not bound to an existing user',
      );
    }

    return {
      userId: identity.id,
      email: identity.email,
      roles: {},
      role: identity.role,
      isAdmin: identity.isAdmin,
      scopes: narrowToIdentity(record.scopes, identity.scopes),
    };
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
