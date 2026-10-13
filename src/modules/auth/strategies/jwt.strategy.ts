import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { noteSeen, refuseIfBlocked } from '../utils/user-presence.util';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as http from 'node:http';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import { extractJwtFromFluiSessionCookie } from '../utils/cookie-extractor.util';
import { OidcProfileSyncService } from '../services/oidc-profile-sync.service';
import { projectRolesOf } from '../utils/credential-ceiling.util';
import {
  SANDBOX_GUEST_ENROLMENT,
  SandboxGuestEnrolment,
} from '../../sandbox/gate/sandbox-guest-enrolment';
import { isTryClient } from '../../sandbox/visitors/visitor.config';
import { visitorGone, visitorMerged } from '../utils/visitor-gone.util';
import { describeError } from '../../shared/utils/error.util';

export {
  VISITOR_GONE_CODE,
  VISITOR_MERGED_CODE,
} from '../utils/visitor-gone.util';

const ROLE_PRECEDENCE: IdentityRole[] = [
  IdentityRole.ADMIN,
  IdentityRole.USER,
  IdentityRole.READONLY,
];

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private static readonly logger = new Logger(JwtStrategy.name);

  constructor(
    configService: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly profileSync: OidcProfileSyncService,
    @Optional()
    @Inject(SANDBOX_GUEST_ENROLMENT)
    private readonly guestEnrolment?: SandboxGuestEnrolment,
  ) {
    const rawIssuer =
      configService.get<string>('OIDC_ISSUER') ||
      configService.get<string>('ZITADEL_ISSUER') ||
      '';
    const issuer =
      rawIssuer && rawIssuer !== 'https://' ? rawIssuer : undefined;
    const audience =
      configService.get<string>('OIDC_AUDIENCE') ||
      configService.get<string>('ZITADEL_AUDIENCE');

    const internalJwksUri =
      configService.get<string>('OIDC_JWKS_URI') ||
      configService.get<string>('ZITADEL_JWKS_URI');
    const jwksUri =
      internalJwksUri || (issuer ? `${issuer}/oauth/v2/keys` : '');

    const authMode = configService.get<string>('AUTH_MODE', '').toLowerCase();

    if (!jwksUri || !issuer) {
      JwtStrategy.logger.warn(
        `OIDC JwtStrategy registered without issuer/jwksUri (AUTH_MODE=${authMode || 'unset'})`,
      );
    }

    const issuerHost = issuer ? new URL(issuer).host : '';
    const jwksOptions: Record<string, unknown> = {
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      timeout: 10000,
      jwksUri:
        jwksUri || 'https://oidc-not-configured.invalid/.well-known/jwks.json',
    };
    // Plain HTTP override for in-cluster JWKS to bypass self-signed TLS.
    if (internalJwksUri?.startsWith('http://')) {
      jwksOptions.requestAgent = new http.Agent();
      jwksOptions.requestHeaders = { Host: issuerHost };
    }

    super({
      secretOrKeyProvider: passportJwtSecret(jwksOptions as any),
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractJwtFromFluiSessionCookie,
      ]),
      audience,
      issuer,
      algorithms: ['RS256'],
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Both claim shapes, because a machine identity's token uses the other one
    // and reading only the human's would drop its ceiling on the floor.
    const roles = projectRolesOf(payload);
    const claimedRole = this.pickHighestRole(roles);

    const user = await this.resolveLocalUser(
      payload.sub,
      payload.email,
      claimedRole,
      typeof payload.email_verified === 'boolean'
        ? payload.email_verified
        : undefined,
      Object.keys(roles).length > 0,
      tokenClientOf(payload),
    );
    refuseIfBlocked(user);
    noteSeen(this.userRepo, user);
    // Refresh the OIDC profile out-of-band: authentication must never block on a
    // provider round-trip, otherwise a slow/stalled provider hangs every request
    // once the sync TTL lapses.
    void this.profileSync
      .syncFromProvider(user)
      .catch((err: unknown) =>
        JwtStrategy.logger.warn(
          `Background profile sync failed: ${describeError(err)}`,
        ),
      );

    return {
      userId: user.id,
      email: user.email,
      name: user.displayName ?? user.name ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      displayName: user.displayName,
      roles,
      role: user.role,
      isAdmin: user.isAdmin,
      scopes: payload.scope
        ? payload.scope.split(' ').filter(Boolean)
        : undefined,
      iat: payload.iat,
    };
  }

  private async isTryToken(clientId: string | null): Promise<boolean> {
    if (this.guestEnrolment?.isTryClient) {
      return this.guestEnrolment.isTryClient(clientId);
    }
    return isTryClient(clientId);
  }

  private pickHighestRole(
    roles: Record<string, Record<string, string>>,
  ): IdentityRole {
    const claimed = Object.keys(roles);
    for (const role of ROLE_PRECEDENCE) {
      if (claimed.includes(role)) return role;
    }
    return IdentityRole.USER;
  }

  /**
   * JIT provisioning: map the OIDC `sub` to a local `users` row.
   * Lookup order: oidcSub → email (attach sub) → create.
   * `role` and `isAdmin` are re-synced from the OIDC claim on every login so
   * role changes propagate without manual intervention.
   */
  private async resolveLocalUser(
    sub: string,
    email: string | undefined,
    claimedRole: IdentityRole,
    emailVerifiedClaim?: boolean,
    hasProviderRoles = false,
    clientId: string | null = null,
  ): Promise<UserEntity> {
    const isAdminFromClaim = claimedRole === IdentityRole.ADMIN;

    const bySub = await this.userRepo.findOne({ where: { oidcSub: sub } });
    if (bySub) {
      if (bySub.role !== claimedRole || bySub.isAdmin !== isAdminFromClaim) {
        bySub.role = claimedRole;
        bySub.isAdmin = isAdminFromClaim;
        return this.userRepo.save(bySub);
      }
      return bySub;
    }

    const retired = await this.guestEnrolment?.isRetiredVisitor?.(sub);
    if (retired === 'merged') throw visitorMerged();
    // A token of a "try" application only ever belongs to a visitor Flui
    // made itself; with no row for it, the visitor is gone and never comes
    // back as a new person with a guest's roles.
    if (retired === 'removed' || (await this.isTryToken(clientId))) {
      throw visitorGone();
    }

    // Permissions are granted to an email, so a login carries its address
    // into Flui only once the provider has proven it: with open registration
    // anyone can type the administrator's email. Unproven, it neither takes
    // over an existing account nor names a new one; the profile sync fills it
    // in once it is verified.
    const verified =
      !!email &&
      (emailVerifiedClaim ?? (await this.profileSync.isEmailVerified(sub)));

    if (email && verified) {
      const byEmail = await this.userRepo.findOne({ where: { email } });
      if (byEmail) {
        byEmail.oidcSub = sub;
        byEmail.role = claimedRole;
        byEmail.isAdmin = isAdminFromClaim;
        JwtStrategy.logger.log(
          `Linked existing user ${email} to OIDC sub ${sub}`,
        );
        return this.userRepo.save(byEmail);
      }
    }

    const created = this.userRepo.create({
      email: email && verified ? email : `oidc-${sub}@flui.invalid`,
      oidcSub: sub,
      role: claimedRole,
      isAdmin: isAdminFromClaim,
      passwordHash: null,
    });
    const saved = await this.userRepo.save(created);
    JwtStrategy.logger.log(
      `Provisioned new local user ${saved.email} (id=${saved.id}, role=${claimedRole}) for sub ${sub}`,
    );
    await this.guestEnrolment?.enrol({
      userId: saved.id,
      email: email && verified ? email : null,
      hasProviderRoles,
      kind: saved.kind,
    });
    return saved;
  }
}

function tokenClientOf(payload: JwtPayload): string | null {
  for (const claim of ['azp', 'client_id']) {
    const value = payload[claim];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}
