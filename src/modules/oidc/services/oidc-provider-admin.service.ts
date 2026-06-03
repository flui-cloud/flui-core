import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const DEFAULT_INTERNAL_URL =
  'http://zitadel.flui-system.svc.cluster.local:8080';

export function resolveProviderBaseUrl(): string {
  return (
    process.env.OIDC_PROVIDER_ADMIN_URL ||
    process.env.OIDC_PROVIDER_INTERNAL_URL ||
    DEFAULT_INTERNAL_URL
  );
}

export function resolveProviderJwksUri(): string {
  return `${resolveProviderBaseUrl()}/oauth/v2/keys`;
}

export interface OidcApp {
  appId: string;
  projectId: string;
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}

export interface OidcProject {
  id: string;
  name: string;
}

export interface OidcRole {
  key: string;
}

export interface OidcUser {
  id: string;
  userName: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  state?: string;
}

export interface OidcUserGrant {
  grantId: string;
  projectId: string;
  roleKeys: string[];
}

export interface OidcLabelPolicy {
  isDefault: boolean;
  primaryColor?: string;
  primaryColorDark?: string;
  backgroundColor?: string;
  backgroundColorDark?: string;
  warnColor?: string;
  fontColor?: string;
  logoUrl?: string;
  logoUrlDark?: string;
  iconUrl?: string;
  iconUrlDark?: string;
  hideLoginNameSuffix?: boolean;
  disableWatermark?: boolean;
}

export type BrandingAssetKind =
  | 'logo-light'
  | 'logo-dark'
  | 'icon-light'
  | 'icon-dark';

const BRANDING_ASSET_PATHS: Record<BrandingAssetKind, string> = {
  'logo-light': '/assets/v1/org/policy/label/logo',
  'logo-dark': '/assets/v1/org/policy/label/logo/dark',
  'icon-light': '/assets/v1/org/policy/label/icon',
  'icon-dark': '/assets/v1/org/policy/label/icon/dark',
};

export interface CreateHumanUserParams {
  userName: string;
  email: string;
  firstName: string;
  lastName: string;
  initialPassword?: string;
  passwordChangeRequired?: boolean;
  isEmailVerified?: boolean;
}

/**
 * Admin API client for the bundled OIDC identity provider (currently Zitadel).
 * Kept behind a generic name so the implementation can be swapped later
 * without touching callers.
 */
@Injectable()
export class OidcProviderAdminClient {
  private readonly logger = new Logger(OidcProviderAdminClient.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * Headers for every provider admin API call.
   * `hostHeader` must match the provider's current ExternalDomain — the pod rejects
   * requests with a different Host. During bootstrap/domain-change the ExternalDomain
   * matches the pod's current config, so callers pass the domain in use at the
   * moment of the call (e.g. the OLD domain during a sync, or the bootstrap
   * nip.io domain right after cluster creation).
   */
  private headers(pat: string, hostHeader: string): Record<string, string> {
    return {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Host: hostHeader,
    };
  }

  async verifyPat(pat: string, hostHeader: string): Promise<string | null> {
    try {
      const resp = await firstValueFrom(
        this.httpService.get(`${resolveProviderBaseUrl()}/auth/v1/users/me`, {
          headers: this.headers(pat, hostHeader),
        }),
      );
      return resp.data?.user?.userName ?? null;
    } catch (err) {
      this.logger.error(`PAT verification failed: ${err.message}`);
      return null;
    }
  }

  async findProjectByName(
    pat: string,
    hostHeader: string,
    name: string,
  ): Promise<OidcProject | null> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/projects/_search`,
        {
          queries: [
            { nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } },
          ],
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    const match = resp.data?.result?.[0];
    return match ? { id: match.id, name: match.name } : null;
  }

  async createProject(
    pat: string,
    hostHeader: string,
    name: string,
  ): Promise<OidcProject> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/projects`,
        { name, projectRoleAssertion: true },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return { id: resp.data.id, name };
  }

  async findRole(
    pat: string,
    hostHeader: string,
    projectId: string,
    roleKey: string,
  ): Promise<OidcRole | null> {
    try {
      const resp = await firstValueFrom(
        this.httpService.post(
          `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/roles/_search`,
          {},
          { headers: this.headers(pat, hostHeader) },
        ),
      );
      const match = (resp.data?.result ?? []).find(
        (r: { key: string }) => r.key === roleKey,
      );
      return match ? { key: match.key } : null;
    } catch {
      return null;
    }
  }

  async createRole(
    pat: string,
    hostHeader: string,
    projectId: string,
    roleKey: string,
    displayName: string,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.post(
          `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/roles`,
          { roleKey, displayName },
          { headers: this.headers(pat, hostHeader) },
        ),
      );
    } catch (err) {
      // Zitadel returns 409-like error with code 6 when role already exists.
      const data = err.response?.data;
      if (data?.code === 6 || data?.message?.includes('already exists')) {
        return;
      }
      throw err;
    }
  }

  async findOidcAppByName(
    pat: string,
    hostHeader: string,
    projectId: string,
    name: string,
  ): Promise<OidcApp | null> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/apps/_search`,
        {
          queries: [
            { nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } },
          ],
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    const match = resp.data?.result?.[0];
    if (!match?.oidcConfig?.clientId) return null;
    return {
      appId: match.id,
      projectId,
      clientId: match.oidcConfig.clientId,
      redirectUris: match.oidcConfig.redirectUris ?? [],
      postLogoutRedirectUris: match.oidcConfig.postLogoutRedirectUris ?? [],
    };
  }

  async deleteOidcApp(
    pat: string,
    hostHeader: string,
    projectId: string,
    appId: string,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.delete(
        `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/apps/${appId}`,
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  async createOidcApp(
    pat: string,
    hostHeader: string,
    projectId: string,
    params: {
      name: string;
      redirectUris: string[];
      postLogoutRedirectUris: string[];
    },
  ): Promise<OidcApp> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/apps/oidc`,
        {
          name: params.name,
          redirectUris: params.redirectUris,
          postLogoutRedirectUris: params.postLogoutRedirectUris,
          responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
          grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
          appType: 'OIDC_APP_TYPE_USER_AGENT',
          authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
          accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
          accessTokenRoleAssertion: true,
          idTokenRoleAssertion: true,
          idTokenUserinfoAssertion: true,
          devMode: true,
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return {
      appId: resp.data.appId,
      projectId,
      clientId: resp.data.clientId,
      redirectUris: params.redirectUris,
      postLogoutRedirectUris: params.postLogoutRedirectUris,
    };
  }

  async createWebOidcApp(
    pat: string,
    hostHeader: string,
    projectId: string,
    params: {
      name: string;
      redirectUris: string[];
      postLogoutRedirectUris?: string[];
    },
  ): Promise<OidcApp> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/apps/oidc`,
        {
          name: params.name,
          redirectUris: params.redirectUris,
          postLogoutRedirectUris: params.postLogoutRedirectUris ?? [],
          responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
          grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
          appType: 'OIDC_APP_TYPE_WEB',
          authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
          accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return {
      appId: resp.data.appId,
      projectId,
      clientId: resp.data.clientId,
      clientSecret: resp.data.clientSecret,
      redirectUris: params.redirectUris,
      postLogoutRedirectUris: params.postLogoutRedirectUris ?? [],
    };
  }

  async createNativeOidcApp(
    pat: string,
    hostHeader: string,
    projectId: string,
    name: string,
    redirectUris: string[],
  ): Promise<OidcApp> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/apps/oidc`,
        {
          name,
          redirectUris,
          postLogoutRedirectUris: [],
          responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
          grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
          appType: 'OIDC_APP_TYPE_NATIVE',
          authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
          accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
          accessTokenRoleAssertion: true,
          idTokenRoleAssertion: true,
          idTokenUserinfoAssertion: true,
          devMode: true,
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return {
      appId: resp.data.appId,
      projectId,
      clientId: resp.data.clientId,
      redirectUris,
      postLogoutRedirectUris: [],
    };
  }

  /**
   * Replaces the OIDC config of an existing app. Zitadel's PUT replaces the
   * whole oidcConfig block, so we fetch the current one and echo back the
   * non-URI fields unchanged.
   */
  async updateOidcAppUris(
    pat: string,
    hostHeader: string,
    app: OidcApp,
    updates: { redirectUris: string[]; postLogoutRedirectUris: string[] },
  ): Promise<void> {
    const existing = await firstValueFrom(
      this.httpService.get(
        `${resolveProviderBaseUrl()}/management/v1/projects/${app.projectId}/apps/${app.appId}`,
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    const oidc = existing.data?.app?.oidcConfig ?? {};

    await firstValueFrom(
      this.httpService.put(
        `${resolveProviderBaseUrl()}/management/v1/projects/${app.projectId}/apps/${app.appId}/oidc_config`,
        {
          redirectUris: updates.redirectUris,
          postLogoutRedirectUris: updates.postLogoutRedirectUris,
          responseTypes: oidc.responseTypes,
          grantTypes: oidc.grantTypes,
          appType: oidc.appType,
          authMethodType: oidc.authMethodType,
          accessTokenType: oidc.accessTokenType,
          accessTokenRoleAssertion: oidc.accessTokenRoleAssertion,
          idTokenRoleAssertion: oidc.idTokenRoleAssertion,
          idTokenUserinfoAssertion: oidc.idTokenUserinfoAssertion,
          devMode: oidc.devMode,
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  /**
   * Idempotently ensures the OIDC app has role-assertion flags enabled so
   * access/id tokens carry the `urn:zitadel:iam:org:project:roles` claim.
   * Returns true if a PUT was performed, false if the config was already ok.
   */
  async ensureRoleAssertionFlags(
    pat: string,
    hostHeader: string,
    projectId: string,
    appId: string,
  ): Promise<boolean> {
    const existing = await firstValueFrom(
      this.httpService.get(
        `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/apps/${appId}`,
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    const oidc = existing.data?.app?.oidcConfig ?? {};

    const alreadyEnabled =
      oidc.accessTokenRoleAssertion === true &&
      oidc.idTokenRoleAssertion === true &&
      oidc.idTokenUserinfoAssertion === true;
    if (alreadyEnabled) return false;

    await firstValueFrom(
      this.httpService.put(
        `${resolveProviderBaseUrl()}/management/v1/projects/${projectId}/apps/${appId}/oidc_config`,
        {
          redirectUris: oidc.redirectUris,
          postLogoutRedirectUris: oidc.postLogoutRedirectUris,
          responseTypes: oidc.responseTypes,
          grantTypes: oidc.grantTypes,
          appType: oidc.appType,
          authMethodType: oidc.authMethodType,
          accessTokenType: oidc.accessTokenType,
          accessTokenRoleAssertion: true,
          idTokenRoleAssertion: true,
          idTokenUserinfoAssertion: true,
          devMode: oidc.devMode,
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return true;
  }

  async findUserByUsername(
    pat: string,
    hostHeader: string,
    usernamePrefix: string,
  ): Promise<OidcUser | null> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/users/_search`,
        {
          queries: [
            {
              userNameQuery: {
                userName: usernamePrefix,
                method: 'TEXT_QUERY_METHOD_STARTS_WITH',
              },
            },
          ],
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    const match = resp.data?.result?.[0];
    return match ? { id: match.id, userName: match.userName } : null;
  }

  async findUserByEmail(
    pat: string,
    hostHeader: string,
    email: string,
  ): Promise<OidcUser | null> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/users/_search`,
        {
          queries: [
            {
              emailQuery: {
                emailAddress: email,
                method: 'TEXT_QUERY_METHOD_EQUALS',
              },
            },
          ],
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    const match = resp.data?.result?.[0];
    return match ? { id: match.id, userName: match.userName } : null;
  }

  async createHumanUser(
    pat: string,
    hostHeader: string,
    params: CreateHumanUserParams,
  ): Promise<OidcUser> {
    const body: Record<string, unknown> = {
      userName: params.userName,
      profile: {
        firstName: params.firstName,
        lastName: params.lastName,
        displayName: `${params.firstName} ${params.lastName}`.trim(),
      },
      email: {
        email: params.email,
        isEmailVerified: params.isEmailVerified ?? true,
      },
    };
    if (params.initialPassword) {
      body.password = params.initialPassword;
      body.passwordChangeRequired = params.passwordChangeRequired ?? true;
    }
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/users/human/_import`,
        body,
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return {
      id: resp.data.userId,
      userName: params.userName,
      email: params.email,
      firstName: params.firstName,
      lastName: params.lastName,
    };
  }

  async listUsers(
    pat: string,
    hostHeader: string,
    query?: { limit?: number; offset?: number; emailContains?: string },
  ): Promise<OidcUser[]> {
    const queries: Array<Record<string, unknown>> = [];
    if (query?.emailContains) {
      queries.push({
        emailQuery: {
          emailAddress: query.emailContains,
          method: 'TEXT_QUERY_METHOD_CONTAINS',
        },
      });
    }
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/users/_search`,
        {
          query: {
            offset: String(query?.offset ?? 0),
            limit: query?.limit ?? 100,
            asc: true,
          },
          queries,
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return ((resp.data?.result as any[]) ?? []).map(this.mapUser);
  }

  async getUser(
    pat: string,
    hostHeader: string,
    userId: string,
  ): Promise<OidcUser | null> {
    try {
      const resp = await firstValueFrom(
        this.httpService.get(
          `${resolveProviderBaseUrl()}/management/v1/users/${userId}`,
          { headers: this.headers(pat, hostHeader) },
        ),
      );
      return resp.data?.user ? this.mapUser(resp.data.user) : null;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response
        ?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  async deleteUser(
    pat: string,
    hostHeader: string,
    userId: string,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.delete(
        `${resolveProviderBaseUrl()}/management/v1/users/${userId}`,
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  async resendUserInitialization(
    pat: string,
    hostHeader: string,
    userId: string,
    email: string,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/users/${userId}/_resend_initialization`,
        { email },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  async setUserPassword(
    pat: string,
    hostHeader: string,
    userId: string,
    password: string,
    changeRequired = true,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/users/${userId}/password`,
        { password, noChangeRequired: !changeRequired },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  async listUserGrants(
    pat: string,
    hostHeader: string,
    userId: string,
  ): Promise<OidcUserGrant[]> {
    const resp = await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/users/grants/_search`,
        {
          queries: [{ userIdQuery: { userId } }],
        },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
    return ((resp.data?.result as any[]) ?? []).map((g) => ({
      grantId: g.id,
      projectId: g.projectId,
      roleKeys: g.roleKeys ?? [],
    }));
  }

  async revokeUserGrant(
    pat: string,
    hostHeader: string,
    userId: string,
    grantId: string,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.delete(
        `${resolveProviderBaseUrl()}/management/v1/users/${userId}/grants/${grantId}`,
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  async getLabelPolicy(
    pat: string,
    hostHeader: string,
  ): Promise<OidcLabelPolicy | null> {
    try {
      const resp = await firstValueFrom(
        this.httpService.get(
          `${resolveProviderBaseUrl()}/management/v1/policies/label`,
          { headers: this.headers(pat, hostHeader) },
        ),
      );
      const p = resp.data?.policy;
      if (!p) return null;
      return {
        isDefault: !!p.isDefault,
        primaryColor: p.primaryColor,
        primaryColorDark: p.primaryColorDark,
        backgroundColor: p.backgroundColor,
        backgroundColorDark: p.backgroundColorDark,
        warnColor: p.warnColor,
        fontColor: p.fontColor,
        logoUrl: p.logoUrl,
        logoUrlDark: p.logoUrlDark,
        iconUrl: p.iconUrl,
        iconUrlDark: p.iconUrlDark,
        hideLoginNameSuffix: p.hideLoginNameSuffix,
        disableWatermark: p.disableWatermark,
      };
    } catch {
      return null;
    }
  }

  async upsertCustomLabelPolicy(
    pat: string,
    hostHeader: string,
    policy: Omit<OidcLabelPolicy, 'isDefault'>,
  ): Promise<void> {
    const current = await this.getLabelPolicy(pat, hostHeader);
    const body = {
      primaryColor: policy.primaryColor,
      primaryColorDark: policy.primaryColorDark,
      backgroundColor: policy.backgroundColor,
      backgroundColorDark: policy.backgroundColorDark,
      warnColor: policy.warnColor,
      fontColor: policy.fontColor,
      hideLoginNameSuffix: policy.hideLoginNameSuffix ?? false,
      disableWatermark: policy.disableWatermark ?? true,
    };
    const headers = this.headers(pat, hostHeader);
    const url = `${resolveProviderBaseUrl()}/management/v1/policies/label`;
    if (!current || current.isDefault) {
      await firstValueFrom(this.httpService.post(url, body, { headers }));
    } else {
      await firstValueFrom(this.httpService.put(url, body, { headers }));
    }
  }

  async activateLabelPolicy(pat: string, hostHeader: string): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/policies/label/_activate`,
        {},
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  /**
   * Uploads a branding asset (logo/icon, light/dark) to the provider.
   * Provider stores it under the org's label policy and serves it from
   * the asset URL returned via getLabelPolicy after activation.
   */
  async uploadBrandingAsset(
    pat: string,
    hostHeader: string,
    kind: BrandingAssetKind,
    fileBytes: Buffer,
    fileName: string,
    contentType: string,
  ): Promise<void> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(fileBytes)], { type: contentType });
    form.append('file', blob, fileName);
    await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}${BRANDING_ASSET_PATHS[kind]}`,
        form,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Host: hostHeader,
            // Content-Type is set automatically by axios when body is FormData.
          },
        },
      ),
    );
  }

  async getOrgMetadata(
    pat: string,
    hostHeader: string,
    key: string,
  ): Promise<string | null> {
    try {
      const resp = await firstValueFrom(
        this.httpService.get(
          `${resolveProviderBaseUrl()}/management/v1/orgs/me/metadata/${encodeURIComponent(key)}`,
          { headers: this.headers(pat, hostHeader) },
        ),
      );
      const value = resp.data?.metadata?.value;
      if (!value) return null;
      try {
        return Buffer.from(String(value), 'base64').toString('utf8');
      } catch {
        return String(value);
      }
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response
        ?.status;
      if (status === 404 || status === 5) return null;
      return null;
    }
  }

  async setOrgMetadata(
    pat: string,
    hostHeader: string,
    key: string,
    value: string,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${resolveProviderBaseUrl()}/management/v1/orgs/me/metadata/${encodeURIComponent(key)}`,
        { value: Buffer.from(value, 'utf8').toString('base64') },
        { headers: this.headers(pat, hostHeader) },
      ),
    );
  }

  private readonly mapUser = (raw: any): OidcUser => ({
    id: raw.id,
    userName: raw.userName,
    email: raw.human?.email?.email,
    firstName: raw.human?.profile?.firstName,
    lastName: raw.human?.profile?.lastName,
    state: raw.state,
  });

  async grantUserRole(
    pat: string,
    hostHeader: string,
    userId: string,
    projectId: string,
    roleKeys: string[],
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.post(
          `${resolveProviderBaseUrl()}/management/v1/users/${userId}/grants`,
          { projectId, roleKeys },
          { headers: this.headers(pat, hostHeader) },
        ),
      );
    } catch (err) {
      // Ignore "grant already exists" — Zitadel returns an error for duplicates.
      const data = err.response?.data;
      if (data?.code === 6 || data?.message?.includes('already exists')) {
        return;
      }
      throw err;
    }
  }

  async isReady(hostHeader: string): Promise<boolean> {
    try {
      const resp = await firstValueFrom(
        this.httpService.get(`${resolveProviderBaseUrl()}/debug/ready`, {
          headers: { Host: hostHeader },
          validateStatus: () => true,
        }),
      );
      return resp.status === 200;
    } catch {
      return false;
    }
  }
}
