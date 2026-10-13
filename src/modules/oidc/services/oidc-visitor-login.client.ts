import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { resolveProviderBaseUrl } from './oidc-provider-admin.service';

export interface VisitorSession {
  sessionId: string;
  sessionToken: string;
}

export interface ProviderAuthRequest {
  id: string;
  clientId: string;
  loginHint: string | null;
}

export type TryAppKind = 'web' | 'cli';

export interface TryAppSpec {
  name: string;
  kind: TryAppKind;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  devMode: boolean;
  loginBaseUri: string;
}

export interface PersonalAccessToken {
  tokenId: string;
  token: string;
}

export interface TryApp {
  appId: string;
  clientId: string;
}

interface ExistingOidcConfig {
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  grantTypes?: string[];
  devMode?: boolean;
  loginVersion?: { loginV2?: { baseUri?: string } };
}

const GRANTS = [
  'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
  'OIDC_GRANT_TYPE_REFRESH_TOKEN',
];

const APP_TYPES: Record<TryAppKind, string> = {
  web: 'OIDC_APP_TYPE_USER_AGENT',
  cli: 'OIDC_APP_TYPE_NATIVE',
};

/**
 * The identity provider calls only the visitors' entrance makes: the v2 user,
 * session and auth-request APIs, the login-client credential, and the two
 * "try" applications whose sign-in is handed to Flui.
 */
@Injectable()
export class OidcVisitorLoginClient {
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

  async createHuman(
    pat: string,
    host: string,
    params: { userName: string; email: string; password?: string },
  ): Promise<string> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url('/v2/users/human'),
        {
          username: params.userName,
          profile: { givenName: 'Visitor', familyName: params.userName },
          email: { email: params.email, isVerified: true },
          ...(params.password
            ? { password: { password: params.password, changeRequired: false } }
            : {}),
          metadata: [
            { key: 'flui.visitor', value: Buffer.from('1').toString('base64') },
          ],
        },
        { headers: this.headers(pat, host) },
      ),
    );
    return resp.data.userId;
  }

  async createSession(
    pat: string,
    host: string,
    userId: string,
    password: string,
  ): Promise<VisitorSession> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url('/v2/sessions'),
        { checks: { user: { userId }, password: { password } } },
        { headers: this.headers(pat, host) },
      ),
    );
    return {
      sessionId: resp.data.sessionId,
      sessionToken: resp.data.sessionToken,
    };
  }

  async getAuthRequest(
    pat: string,
    host: string,
    id: string,
  ): Promise<ProviderAuthRequest> {
    const resp = await firstValueFrom(
      this.http.get(
        this.url(`/v2/oidc/auth_requests/${encodeURIComponent(id)}`),
        { headers: this.headers(pat, host) },
      ),
    );
    const req = resp.data?.authRequest ?? {};
    return {
      id: req.id ?? id,
      clientId: req.clientId ?? '',
      loginHint: req.loginHint ?? null,
    };
  }

  async createCallback(
    pat: string,
    host: string,
    authRequestId: string,
    session: VisitorSession,
  ): Promise<string> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url(`/v2/oidc/auth_requests/${encodeURIComponent(authRequestId)}`),
        { session },
        { headers: this.headers(pat, host) },
      ),
    );
    return resp.data.callbackUrl;
  }

  /** Instance membership; an existing one is left as it is. */
  async addInstanceMember(
    pat: string,
    host: string,
    userId: string,
    roles: string[],
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(
          this.url('/admin/v1/members'),
          { userId, roles },
          { headers: this.headers(pat, host) },
        ),
      );
    } catch (error) {
      if (statusOf(error) !== 409) throw error;
    }
  }

  async createPersonalAccessToken(
    pat: string,
    host: string,
    userId: string,
    expiresAt: Date,
  ): Promise<PersonalAccessToken> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url(`/management/v1/users/${encodeURIComponent(userId)}/pats`),
        { expirationDate: expiresAt.toISOString() },
        { headers: this.headers(pat, host) },
      ),
    );
    return { tokenId: resp.data.tokenId, token: resp.data.token };
  }

  async listPersonalAccessTokenIds(
    pat: string,
    host: string,
    userId: string,
  ): Promise<string[]> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url(
          `/management/v1/users/${encodeURIComponent(userId)}/pats/_search`,
        ),
        {},
        { headers: this.headers(pat, host) },
      ),
    );
    const result = (resp.data?.result ?? []) as Array<{ id?: string }>;
    return result.map((r) => r.id).filter((id): id is string => !!id);
  }

  /** One that is already gone is left as it is. */
  async deletePersonalAccessToken(
    pat: string,
    host: string,
    userId: string,
    tokenId: string,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(
          this.url(
            `/management/v1/users/${encodeURIComponent(userId)}/pats/${encodeURIComponent(tokenId)}`,
          ),
          { headers: this.headers(pat, host) },
        ),
      );
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }

  /** Whether a token is still accepted: false on 401/403, the error otherwise. */
  async acceptsToken(pat: string, host: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.get(this.url('/auth/v1/users/me'), {
          headers: this.headers(pat, host),
        }),
      );
      return true;
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) return false;
      throw error;
    }
  }

  async ensureTryApp(
    pat: string,
    host: string,
    projectId: string,
    spec: TryAppSpec,
    existing: { appId: string; clientId: string } | null,
  ): Promise<TryApp> {
    if (!existing) {
      const resp = await firstValueFrom(
        this.http.post(
          this.url(`/management/v1/projects/${projectId}/apps/oidc`),
          { name: spec.name, ...this.oidcConfig(spec) },
          { headers: this.headers(pat, host) },
        ),
      );
      return { appId: resp.data.appId, clientId: resp.data.clientId };
    }
    const current = await firstValueFrom(
      this.http.get(
        this.url(`/management/v1/projects/${projectId}/apps/${existing.appId}`),
        { headers: this.headers(pat, host) },
      ),
    );
    const oidc: ExistingOidcConfig = current.data?.app?.oidcConfig ?? {};
    const merged: TryAppSpec = {
      ...spec,
      redirectUris: union(oidc.redirectUris, spec.redirectUris),
      postLogoutRedirectUris: union(
        oidc.postLogoutRedirectUris,
        spec.postLogoutRedirectUris,
      ),
      devMode: spec.devMode || oidc.devMode === true,
    };
    if (!differs(oidc, merged)) return existing;
    await firstValueFrom(
      this.http.put(
        this.url(
          `/management/v1/projects/${projectId}/apps/${existing.appId}/oidc_config`,
        ),
        this.oidcConfig(merged),
        { headers: this.headers(pat, host) },
      ),
    );
    return existing;
  }

  private oidcConfig(spec: TryAppSpec): Record<string, unknown> {
    return {
      redirectUris: spec.redirectUris,
      postLogoutRedirectUris: spec.postLogoutRedirectUris,
      responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
      grantTypes: GRANTS,
      appType: APP_TYPES[spec.kind],
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
      accessTokenRoleAssertion: true,
      idTokenRoleAssertion: true,
      idTokenUserinfoAssertion: true,
      devMode: spec.devMode,
      loginVersion: { loginV2: { baseUri: spec.loginBaseUri } },
    };
  }
}

function union(current: string[] | undefined, wanted: string[]): string[] {
  return [...new Set([...(current ?? []), ...wanted])];
}

function sameSet(a: string[] | undefined, b: string[]): boolean {
  const left = new Set(a ?? []);
  return left.size === new Set(b).size && b.every((v) => left.has(v));
}

function differs(current: ExistingOidcConfig, wanted: TryAppSpec): boolean {
  return (
    !sameSet(current.redirectUris, wanted.redirectUris) ||
    !sameSet(current.postLogoutRedirectUris, wanted.postLogoutRedirectUris) ||
    !sameSet(current.grantTypes, GRANTS) ||
    (current.devMode === true) !== wanted.devMode ||
    current.loginVersion?.loginV2?.baseUri !== wanted.loginBaseUri
  );
}

export function statusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}
