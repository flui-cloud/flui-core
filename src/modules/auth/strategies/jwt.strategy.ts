import { Injectable, Logger } from '@nestjs/common';
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
    );
    // Refresh the OIDC profile out-of-band: authentication must never block on a
    // provider round-trip, otherwise a slow/stalled provider hangs every request
    // once the sync TTL lapses.
    void this.profileSync
      .syncFromProvider(user)
      .catch((err: unknown) =>
        JwtStrategy.logger.warn(
          `Background profile sync failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
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
    };
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

    if (email) {
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
      email: email ?? `oidc-${sub}@flui.invalid`,
      oidcSub: sub,
      role: claimedRole,
      isAdmin: isAdminFromClaim,
      passwordHash: null,
    });
    const saved = await this.userRepo.save(created);
    JwtStrategy.logger.log(
      `Provisioned new local user ${saved.email} (id=${saved.id}, role=${claimedRole}) for sub ${sub}`,
    );
    return saved;
  }
}
