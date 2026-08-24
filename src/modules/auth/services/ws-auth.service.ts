import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as http from 'node:http';
import { JwksClient } from 'jwks-rsa';
import { Socket } from 'socket.io';
import { ApiKeyStrategy } from '../strategies/api-key.strategy';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import { FLUI_SESSION_COOKIE } from '../utils/cookie-extractor.util';
import { projectRolesOf } from '../utils/credential-ceiling.util';

const ROLE_PRECEDENCE: IdentityRole[] = [
  IdentityRole.ADMIN,
  IdentityRole.USER,
  IdentityRole.READONLY,
];

@Injectable()
export class WsAuthService implements OnModuleInit {
  private readonly logger = new Logger(WsAuthService.name);

  private jwksClient: JwksClient | null = null;
  private issuer: string | undefined;
  private audience: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly apiKeyStrategy: ApiKeyStrategy,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  onModuleInit(): void {
    const rawIssuer =
      this.configService.get<string>('OIDC_ISSUER') ||
      this.configService.get<string>('ZITADEL_ISSUER') ||
      '';
    this.issuer = rawIssuer && rawIssuer !== 'https://' ? rawIssuer : undefined;
    this.audience =
      this.configService.get<string>('OIDC_AUDIENCE') ||
      this.configService.get<string>('ZITADEL_AUDIENCE') ||
      undefined;

    const internalJwksUri =
      this.configService.get<string>('OIDC_JWKS_URI') ||
      this.configService.get<string>('ZITADEL_JWKS_URI');
    const jwksUri =
      internalJwksUri || (this.issuer ? `${this.issuer}/oauth/v2/keys` : '');

    if (!jwksUri) {
      this.logger.warn(
        'WsAuthService initialized without OIDC issuer/JWKS — OIDC socket auth will fail',
      );
      return;
    }

    const issuerHost = this.issuer ? new URL(this.issuer).host : '';
    const opts: Record<string, unknown> = {
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri,
    };
    if (internalJwksUri?.startsWith('http://')) {
      opts.requestAgent = new http.Agent();
      opts.requestHeaders = { Host: issuerHost };
    }
    this.jwksClient = new JwksClient(opts as never);
  }

  async authenticate(socket: Socket): Promise<AuthenticatedUser> {
    const token = this.extractToken(socket);
    if (!token) {
      throw new UnauthorizedException('Missing authentication token');
    }
    if (token.startsWith('flui_')) {
      return this.apiKeyStrategy.validate(token);
    }
    return process.env.AUTH_MODE === 'local'
      ? this.verifyLocal(token)
      : this.verifyOidc(token);
  }

  private extractToken(socket: Socket): string | null {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    if (auth && typeof auth.token === 'string' && auth.token) {
      return auth.token.replace(/^Bearer\s+/i, '');
    }
    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string' && header) {
      return header.replace(/^Bearer\s+/i, '');
    }
    const q = socket.handshake.query?.token;
    if (typeof q === 'string' && q) return q;
    const cookieHeader = socket.handshake.headers.cookie;
    if (typeof cookieHeader === 'string' && cookieHeader) {
      return this.extractSessionCookie(cookieHeader);
    }
    return null;
  }

  private extractSessionCookie(cookieHeader: string): string | null {
    for (const part of cookieHeader.split(';')) {
      const trimmed = part.trim();
      if (!trimmed.startsWith(`${FLUI_SESSION_COOKIE}=`)) continue;
      const raw = trimmed.slice(FLUI_SESSION_COOKIE.length + 1);
      if (!raw) return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    return null;
  }

  private async verifyLocal(token: string): Promise<AuthenticatedUser> {
    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email: string;
        isAdmin?: boolean;
        role?: IdentityRole;
      }>(token);
      return {
        userId: payload.sub,
        email: payload.email,
        roles: {},
        role:
          payload.role ??
          (payload.isAdmin ? IdentityRole.ADMIN : IdentityRole.USER),
        isAdmin: !!payload.isAdmin,
      };
    } catch {
      throw new UnauthorizedException('Invalid local JWT');
    }
  }

  private async verifyOidc(token: string): Promise<AuthenticatedUser> {
    if (!this.jwksClient) {
      throw new UnauthorizedException('OIDC not configured');
    }
    let payload: JwtPayload;
    try {
      const decoded = this.jwtService.decode(token, { complete: true }) as {
        header?: { kid?: string };
      } | null;
      const kid = decoded?.header?.kid;
      if (!kid) {
        throw new Error('Missing kid');
      }
      const signingKey = await this.jwksClient.getSigningKey(kid);
      const publicKey = signingKey.getPublicKey();
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: publicKey,
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
      });
    } catch (err) {
      this.logger.debug(
        `OIDC verify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('Invalid OIDC JWT');
    }

    // Both claim shapes, the same way `JwtStrategy` reads them (decision 115).
    // This door used to read only the human one, and a machine identity — which
    // is the thing most likely to present a token to a socket — carries its
    // roles under `urn:zitadel:iam:org:project:<projectId>:roles`. Reading one
    // of the two left `roles` empty, which is not a narrow answer downstream:
    // it is *no* answer, and the ceiling derived from it is `null`, meaning no
    // ceiling at all.
    const roles = projectRolesOf(payload);
    const claimedRole = this.pickHighestRole(roles);

    const user = await this.userRepo.findOne({
      where: { oidcSub: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException(
        'User not provisioned — sign in via HTTP first',
      );
    }
    return {
      userId: user.id,
      email: user.email,
      roles,
      role: user.role ?? claimedRole,
      isAdmin: user.isAdmin,
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
}
