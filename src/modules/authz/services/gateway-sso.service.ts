import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { CacheService } from '../../common/cache/cache.service';
import { GatewayAuthzService } from './gateway-authz.service';
import { stripTrailingSlashes } from '../../../common/utils/url.util';

/**
 * `__Host-` makes the browser refuse the cookie unless it is Secure, has no
 * Domain and covers the whole host, so a sibling sub-domain cannot plant one.
 * The route is in the name because one host can carry several routes, each
 * signed with its own key.
 */
export const GATEWAY_SSO_COOKIE = '__Host-flui-gw';
export function gatewaySsoCookieName(endpointId: string): string {
  return `${GATEWAY_SSO_COOKIE}-${endpointId.split('-')[0]}`;
}
/** The path on the route's own host that turns a code into the cookie. */
export const GATEWAY_SSO_CALLBACK = '/.flui-sso/callback';

const CODE_TTL_SECONDS = 60;
const SESSION_SECONDS = 8 * 60 * 60;

interface PendingCode {
  userId: string;
  endpointId: string;
  returnUrl: string;
}

/**
 * Browser sign-in for gateway routes that require a Flui login.
 *
 * The route's host is not Flui's, so Flui's own session can never be sent
 * there: it would reach the application behind the route, which could then
 * act as the person against Flui. What the host gets instead is a cookie that
 * only says "this person signed in for this route", signed with a key derived
 * for that route alone and short-lived; the role is checked again on every
 * request, so a grant removed takes effect at once.
 *
 * The dashboard, where the person is signed in, asks for a one-time code for
 * one route and one address on it; the route's host exchanges it once, within
 * a minute, for the cookie.
 */
@Injectable()
export class GatewaySsoService {
  constructor(
    @InjectRepository(AppEndpointEntity)
    private readonly endpoints: Repository<AppEndpointEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly authz: GatewayAuthzService,
    private readonly encryption: EncryptionService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  /** Where a browser without a session is sent to sign in. */
  loginUrl(endpointId: string, returnUrl: string): string {
    let base =
      this.config.get<string>('FRONTEND_URL') ??
      this.config.get<string>('DASHBOARD_URL') ??
      'http://localhost:4200';
    while (base.endsWith('/')) base = base.slice(0, -1);
    const query = new URLSearchParams({ route: endpointId, return: returnUrl });
    return `${base}/gateway-login?${query.toString()}`;
  }

  /**
   * A one-time code for a person already signed in to Flui. Refused unless
   * the person may open the route now, and unless the address they will be
   * sent back to is on the route's own host — anything else would make this
   * an open redirect carrying a credential.
   */
  async issueCode(
    user: AuthenticatedUser,
    endpointId: string,
    returnUrl: string,
  ): Promise<{ redirect: string }> {
    const { endpoint } = await this.authz.authorizeRoute(user, endpointId);
    const target = this.sameHostUrl(returnUrl, endpoint.fqdn);
    const code = crypto.randomBytes(32).toString('base64url');
    await this.cache.set<PendingCode>(
      this.codeKey(code),
      { userId: user.userId, endpointId, returnUrl: target.toString() },
      { ttl: CODE_TTL_SECONDS },
    );
    // Under the route's own path: a route that owns only `/api` of its host
    // would never see a callback at the root.
    const prefix = stripTrailingSlashes(endpoint.gatewayConfig?.path ?? '');
    const callback = new URL(
      `https://${endpoint.fqdn}${prefix}${GATEWAY_SSO_CALLBACK}`,
    );
    callback.searchParams.set('code', code);
    return { redirect: callback.toString() };
  }

  /** Spend a code on the route it was issued for; it never works twice. */
  async exchangeCode(
    endpointId: string,
    code: string | null,
  ): Promise<{ cookie: string; returnUrl: string }> {
    if (!code) throw new UnauthorizedException('sign-in code missing');
    const key = this.codeKey(code);
    const pending = await this.cache.get<PendingCode>(key);
    await this.cache.delete(key);
    if (pending?.endpointId !== endpointId) {
      throw new UnauthorizedException(
        'sign-in code expired or already used — open the page again',
      );
    }
    return {
      cookie: this.serializeCookie(
        endpointId,
        this.mint(pending.userId, endpointId),
      ),
      returnUrl: pending.returnUrl,
    };
  }

  /**
   * The person a route's cookie names, rebuilt from their account as it is
   * now — never from what the cookie says about their role.
   */
  async userFromCookie(
    endpointId: string,
    cookieHeader: string | undefined,
  ): Promise<AuthenticatedUser | null> {
    const value = this.readCookie(endpointId, cookieHeader);
    const userId = value ? this.verify(value, endpointId) : null;
    if (!userId) return null;
    const account = await this.users.findOne({ where: { id: userId } });
    if (!account) return null;
    return {
      userId: account.id,
      email: account.email,
      name: account.displayName ?? account.name ?? null,
      roles: {},
      role: account.role,
      isAdmin: account.isAdmin,
    };
  }

  mint(userId: string, endpointId: string, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + SESSION_SECONDS;
    const body = `v1.${userId}.${exp}`;
    return `${body}.${this.sign(body, endpointId)}`;
  }

  verify(value: string, endpointId: string, now = Date.now()): string | null {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, userId, expRaw, mac] = parts;
    const expected = this.sign(`v1.${userId}.${expRaw}`, endpointId);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Number(expRaw) * 1000 <= now) return null;
    return userId;
  }

  serializeCookie(endpointId: string, value: string): string {
    return `${gatewaySsoCookieName(endpointId)}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
  }

  private sign(body: string, endpointId: string): string {
    const key = this.encryption.deriveSubkey(`gateway-sso.${endpointId}`);
    return crypto.createHmac('sha256', key).update(body).digest('base64url');
  }

  private readCookie(
    endpointId: string,
    header: string | undefined,
  ): string | null {
    const wanted = gatewaySsoCookieName(endpointId);
    for (const part of (header ?? '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === wanted) return rest.join('=');
    }
    return null;
  }

  private sameHostUrl(raw: string, fqdn: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('return address is not a URL');
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== fqdn) {
      throw new BadRequestException(
        `sign-in can only return to https://${fqdn}`,
      );
    }
    return url;
  }

  private codeKey(code: string): string {
    const digest = crypto.createHash('sha256').update(code).digest('hex');
    return `gateway-sso:code:${digest}`;
  }

  /** The address the browser asked for, read from what the proxy forwarded. */
  static originalUrl(
    fqdn: string,
    forwardedUri: string | undefined,
  ): string | null {
    if (!forwardedUri?.startsWith('/')) return null;
    return `https://${fqdn}${forwardedUri}`;
  }

  async endpointFqdn(endpointId: string): Promise<string> {
    const endpoint = await this.endpoints.findOne({
      where: { id: endpointId },
    });
    if (!endpoint) {
      throw new NotFoundException(`route ${endpointId} does not exist`);
    }
    return endpoint.fqdn;
  }
}
