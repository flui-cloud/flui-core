import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { resolveProviderBaseUrl } from './oidc-provider-admin.service';
import { statusOf } from './oidc-visitor-login.client';

export interface AccountUser {
  userId: string;
  orgId: string | null;
  userName: string;
  email: string | null;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
}

export interface AccountProfileChange {
  givenName: string;
  familyName: string;
  displayName: string;
}

export interface PasswordComplexity {
  minLength: number;
  requiresUppercase: boolean;
  requiresLowercase: boolean;
  requiresNumber: boolean;
  requiresSymbol: boolean;
}

export interface NamedFactor {
  id: string;
  name: string;
  ready: boolean;
}

export interface SecondFactors {
  totp: boolean;
  securityKeys: NamedFactor[];
  otpSms: boolean;
  otpEmail: boolean;
}

export interface IdpLink {
  idpId: string;
  externalUserId: string;
  externalUserName: string;
}

/** valid, wrong, or right but the account may not sign in (locked or deactivated). */
export type PasswordCheck = 'valid' | 'invalid' | 'locked';

export interface TotpRegistration {
  uri: string;
  secret: string;
}

/** The method types the provider reports for a user, without its prefix. */
export type AuthMethod =
  | 'PASSWORD'
  | 'PASSKEY'
  | 'IDP'
  | 'TOTP'
  | 'U2F'
  | 'OTP_SMS'
  | 'OTP_EMAIL';

const DEFAULT_COMPLEXITY: PasswordComplexity = {
  minLength: 8,
  requiresUppercase: true,
  requiresLowercase: true,
  requiresNumber: true,
  requiresSymbol: true,
};

const PASSWORD_CHECK_LIFETIME = '30s';
const PASSWORD_CHECK_AGENT = 'Flui password check';
const ACCOUNT_BLOCKED = /lock|precondition|not.?active|inactive|deactivat/i;

/**
 * The identity provider calls a person's own account page makes, through the v2
 * user, session and settings APIs with Flui's service credential. Every method
 * takes the provider user id explicitly; deciding that it is the caller's own is
 * the account service's job, never this client's.
 */
@Injectable()
export class OidcAccountClient {
  private readonly logger = new Logger(OidcAccountClient.name);

  constructor(private readonly http: HttpService) {}

  private headers(pat: string, host: string): Record<string, string> {
    return {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Host: host,
    };
  }

  private url(path: string): string {
    return `${resolveProviderBaseUrl()}${path}`;
  }

  private user(userId: string): string {
    return `/v2/users/${encodeURIComponent(userId)}`;
  }

  async getUser(
    pat: string,
    host: string,
    userId: string,
  ): Promise<AccountUser> {
    const resp = await firstValueFrom(
      this.http.get(this.url(this.user(userId)), {
        headers: this.headers(pat, host),
      }),
    );
    const user = resp.data?.user ?? {};
    const human = user.human ?? {};
    return {
      userId: text(user.userId) ?? userId,
      orgId:
        text(resp.data?.details?.resourceOwner) ??
        text(user.details?.resourceOwner),
      userName: text(user.username) ?? text(user.preferredLoginName) ?? '',
      email: text(human.email?.email),
      emailVerified: human.email?.isVerified === true,
      givenName: text(human.profile?.givenName),
      familyName: text(human.profile?.familyName),
      displayName: text(human.profile?.displayName),
    };
  }

  async updateProfile(
    pat: string,
    host: string,
    userId: string,
    profile: AccountProfileChange,
  ): Promise<void> {
    await firstValueFrom(
      this.http.put(
        this.url(`/v2/users/human/${encodeURIComponent(userId)}`),
        { profile },
        { headers: this.headers(pat, host) },
      ),
    );
  }

  async authMethods(
    pat: string,
    host: string,
    userId: string,
  ): Promise<AuthMethod[]> {
    const resp = await firstValueFrom(
      this.http.get(this.url(`${this.user(userId)}/authentication_methods`), {
        headers: this.headers(pat, host),
      }),
    );
    const types = (resp.data?.authMethodTypes ?? []) as unknown[];
    return types
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^AUTHENTICATION_METHOD_TYPE_/, '') as AuthMethod);
  }

  /** The organisation's rules, or the provider's defaults when it has none to say. */
  async passwordComplexity(
    pat: string,
    host: string,
    orgId: string | null,
  ): Promise<PasswordComplexity> {
    const query = orgId
      ? `?ctx.orgId=${encodeURIComponent(orgId)}`
      : '?ctx.instance=true';
    const resp = await firstValueFrom(
      this.http.get(this.url(`/v2/settings/password/complexity${query}`), {
        headers: this.headers(pat, host),
      }),
    );
    const s = resp.data?.settings;
    if (!s) return DEFAULT_COMPLEXITY;
    return {
      minLength: Number(s.minLength ?? DEFAULT_COMPLEXITY.minLength) || 0,
      requiresUppercase: s.requiresUppercase === true,
      requiresLowercase: s.requiresLowercase === true,
      requiresNumber: s.requiresNumber === true,
      requiresSymbol: s.requiresSymbol === true,
    };
  }

  /**
   * Whether the password is this user's, proven the way a sign-in proves it:
   * a short-lived session is opened with the password check and closed again at once.
   */
  async checkPassword(
    pat: string,
    host: string,
    userId: string,
    password: string,
  ): Promise<PasswordCheck> {
    let session: { sessionId?: string };
    try {
      const resp = await firstValueFrom(
        this.http.post(
          this.url('/v2/sessions'),
          {
            checks: { user: { userId }, password: { password } },
            lifetime: PASSWORD_CHECK_LIFETIME,
            userAgent: { description: PASSWORD_CHECK_AGENT },
          },
          { headers: this.headers(pat, host) },
        ),
      );
      session = resp.data ?? {};
    } catch (error) {
      const status = statusOf(error);
      if (status === 400 && ACCOUNT_BLOCKED.test(messageOf(error))) {
        return 'locked';
      }
      if (status === 400 || status === 412 || status === 409) return 'invalid';
      throw error;
    }
    if (session.sessionId) {
      const sessionId = session.sessionId;
      await this.deleteSession(pat, host, sessionId).catch((error) =>
        this.logger.warn(
          `Could not end password check session ${sessionId}; it expires by itself in ${PASSWORD_CHECK_LIFETIME} (${statusOf(error) ?? 'no status'})`,
        ),
      );
    }
    return 'valid';
  }

  async setPassword(
    pat: string,
    host: string,
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(
        this.url(`${this.user(userId)}/password`),
        {
          newPassword: { password: newPassword, changeRequired: false },
          currentPassword,
        },
        { headers: this.headers(pat, host) },
      ),
    );
  }

  async registerTotp(
    pat: string,
    host: string,
    userId: string,
  ): Promise<TotpRegistration> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url(`${this.user(userId)}/totp`),
        {},
        { headers: this.headers(pat, host) },
      ),
    );
    const uri = text(resp.data?.uri);
    const secret = text(resp.data?.secret);
    if (!uri || !secret) {
      throw new Error('The identity provider returned no authenticator secret');
    }
    return { uri, secret };
  }

  async verifyTotp(
    pat: string,
    host: string,
    userId: string,
    code: string,
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(
        this.url(`${this.user(userId)}/totp/verify`),
        { code },
        { headers: this.headers(pat, host) },
      ),
    );
  }

  async removeTotp(pat: string, host: string, userId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(this.url(`${this.user(userId)}/totp`), {
        headers: this.headers(pat, host),
      }),
    );
  }

  async listPasskeys(
    pat: string,
    host: string,
    userId: string,
  ): Promise<NamedFactor[]> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url(`${this.user(userId)}/passkeys/_search`),
        {},
        { headers: this.headers(pat, host) },
      ),
    );
    return ((resp.data?.result ?? []) as Array<Record<string, unknown>>)
      .map((p) => ({
        id: text(p.id) ?? '',
        name: text(p.name) ?? '',
        ready: p.state === 'AUTH_FACTOR_STATE_READY',
      }))
      .filter((p) => p.id);
  }

  async removePasskey(
    pat: string,
    host: string,
    userId: string,
    passkeyId: string,
  ): Promise<void> {
    await firstValueFrom(
      this.http.delete(
        this.url(
          `${this.user(userId)}/passkeys/${encodeURIComponent(passkeyId)}`,
        ),
        { headers: this.headers(pat, host) },
      ),
    );
  }

  /**
   * One-time codes and security keys. Read from the v2 listing, and from the
   * management API on a provider that predates it, which answers the same shape.
   */
  async secondFactors(
    pat: string,
    host: string,
    userId: string,
  ): Promise<SecondFactors> {
    let result: Array<Record<string, any>>;
    try {
      const resp = await firstValueFrom(
        this.http.post(
          this.url(`${this.user(userId)}/authentication_factors/_search`),
          {},
          { headers: this.headers(pat, host) },
        ),
      );
      result = resp.data?.result ?? [];
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      const resp = await firstValueFrom(
        this.http.post(
          this.url(
            `/management/v1/users/${encodeURIComponent(userId)}/auth_factors/_search`,
          ),
          {},
          { headers: this.headers(pat, host) },
        ),
      );
      result = resp.data?.result ?? [];
    }
    const ready = (f: Record<string, any>) =>
      f.state === undefined || f.state === 'AUTH_FACTOR_STATE_READY';
    return {
      totp: result.some((f) => f.otp && ready(f)),
      otpSms: result.some((f) => f.otpSms && ready(f)),
      otpEmail: result.some((f) => f.otpEmail && ready(f)),
      securityKeys: result
        .filter((f) => f.u2f)
        .map((f) => ({
          id: text(f.u2f.id) ?? '',
          name: text(f.u2f.name) ?? '',
          ready: ready(f),
        }))
        .filter((f) => f.id),
    };
  }

  async removeSecurityKey(
    pat: string,
    host: string,
    userId: string,
    keyId: string,
  ): Promise<void> {
    await firstValueFrom(
      this.http.delete(
        this.url(`${this.user(userId)}/u2f/${encodeURIComponent(keyId)}`),
        { headers: this.headers(pat, host) },
      ),
    );
  }

  async listIdpLinks(
    pat: string,
    host: string,
    userId: string,
  ): Promise<IdpLink[]> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url(`${this.user(userId)}/links/_search`),
        {},
        { headers: this.headers(pat, host) },
      ),
    );
    return ((resp.data?.result ?? []) as Array<Record<string, unknown>>)
      .map((l) => ({
        idpId: text(l.idpId) ?? '',
        externalUserId: text(l.userId) ?? '',
        externalUserName: text(l.userName) ?? '',
      }))
      .filter((l) => l.idpId && l.externalUserId);
  }

  /** The provider's name for a sign-in provider; null when it cannot say. */
  async idpName(
    pat: string,
    host: string,
    idpId: string,
  ): Promise<string | null> {
    try {
      const resp = await firstValueFrom(
        this.http.get(this.url(`/v2/idps/${encodeURIComponent(idpId)}`), {
          headers: this.headers(pat, host),
        }),
      );
      return text(resp.data?.idp?.name);
    } catch {
      return null;
    }
  }

  async removeIdpLink(
    pat: string,
    host: string,
    userId: string,
    link: { idpId: string; externalUserId: string },
  ): Promise<void> {
    await firstValueFrom(
      this.http.delete(
        this.url(
          `${this.user(userId)}/links/${encodeURIComponent(link.idpId)}/${encodeURIComponent(link.externalUserId)}`,
        ),
        { headers: this.headers(pat, host) },
      ),
    );
  }

  async deleteSession(
    pat: string,
    host: string,
    sessionId: string,
  ): Promise<void> {
    await firstValueFrom(
      this.http.delete(
        this.url(`/v2/sessions/${encodeURIComponent(sessionId)}`),
        { headers: this.headers(pat, host), data: {} },
      ),
    );
  }
}

function messageOf(error: unknown): string {
  const message = (error as { response?: { data?: { message?: unknown } } })
    ?.response?.data?.message;
  return typeof message === 'string' ? message : '';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
