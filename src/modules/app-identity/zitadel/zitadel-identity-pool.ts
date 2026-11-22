import {
  IdentityClient,
  IdentityPool,
  IdentityUser,
  IdentityUserState,
  InvitedUser,
  NewIdentityClient,
} from './identity-pool';
import { zitadelSystemToken } from './zitadel-system-token';

type Fetch = typeof fetch;

export class IdentityPoolError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const STATES: Record<string, IdentityUserState> = {
  USER_STATE_ACTIVE: 'active',
  USER_STATE_INITIAL: 'invited',
  USER_STATE_INACTIVE: 'blocked',
  USER_STATE_LOCKED: 'locked',
};

interface ZitadelUser {
  userId: string;
  username: string;
  state?: string;
  human?: { email?: { email?: string } };
}

/** The one implementation of the identity pool: a Zitadel instance reached as its system API user. */
export class ZitadelIdentityPool implements IdentityPool {
  private orgId: string | null = null;

  constructor(
    readonly issuer: string,
    private readonly privateKeyPem: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    orgScoped = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${zitadelSystemToken(this.privateKeyPem, this.issuer)}`,
      'Content-Type': 'application/json',
    };
    if (orgScoped) headers['x-zitadel-orgid'] = await this.org();
    const response = await this.fetchFn(`${this.issuer}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const message =
        typeof json.message === 'string' ? json.message : response.statusText;
      throw new IdentityPoolError(message, response.status);
    }
    return json as T;
  }

  private async org(): Promise<string> {
    if (this.orgId) return this.orgId;
    const { result } = await this.call<{ result?: Array<{ id: string }> }>(
      'POST',
      '/admin/v1/orgs/_search',
      {},
    );
    const id = result?.[0]?.id;
    if (!id)
      throw new IdentityPoolError(
        'The identity server has no organization',
        502,
      );
    this.orgId = id;
    return id;
  }

  async ensureProject(name: string): Promise<string> {
    const { result } = await this.call<{
      result?: Array<{ id: string; name: string }>;
    }>(
      'POST',
      '/management/v1/projects/_search',
      {
        queries: [{ nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
      },
      true,
    );
    const found = result?.find((p) => p.name === name);
    if (found) return found.id;
    const created = await this.call<{ id: string }>(
      'POST',
      '/management/v1/projects',
      { name },
      true,
    );
    return created.id;
  }

  async createClient(
    projectId: string,
    client: NewIdentityClient,
  ): Promise<IdentityClient> {
    const app = await this.call<{
      appId: string;
      clientId: string;
      clientSecret: string;
    }>(
      'POST',
      `/management/v1/projects/${encodeURIComponent(projectId)}/apps/oidc`,
      {
        name: client.name,
        redirectUris: client.redirectUris,
        postLogoutRedirectUris: client.postLogoutRedirectUris,
        responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
        grantTypes: [
          'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
          'OIDC_GRANT_TYPE_REFRESH_TOKEN',
        ],
        appType: 'OIDC_APP_TYPE_WEB',
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
        accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
      },
      true,
    );
    return {
      appId: app.appId,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
    };
  }

  async deleteClient(projectId: string, appId: string): Promise<void> {
    try {
      await this.call(
        'DELETE',
        `/management/v1/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}`,
        undefined,
        true,
      );
    } catch (error) {
      if (error instanceof IdentityPoolError && error.status === 404) return;
      throw error;
    }
  }

  async listUsers(): Promise<IdentityUser[]> {
    const { result } = await this.call<{ result?: ZitadelUser[] }>(
      'POST',
      '/v2/users',
      {
        queries: [
          { organizationIdQuery: { organizationId: await this.org() } },
        ],
      },
    );
    return (result ?? []).map((u) => ({
      id: u.userId,
      username: u.username,
      email: u.human?.email?.email ?? null,
      state: STATES[u.state ?? ''] ?? 'active',
    }));
  }

  async inviteUser(user: InvitedUser): Promise<{ id: string }> {
    const created = await this.call<{ userId: string }>(
      'POST',
      '/v2/users/human',
      {
        username: user.email,
        profile: { givenName: user.givenName, familyName: user.familyName },
        email: { email: user.email, isVerified: false },
        organization: { orgId: await this.org() },
      },
    );
    await this.call(
      'POST',
      `/v2/users/${encodeURIComponent(created.userId)}/invite_code`,
      {
        sendCode: {},
      },
    );
    return { id: created.userId };
  }

  async exportUsers(): Promise<unknown> {
    return this.call('POST', '/admin/v1/export', {
      withPasswords: true,
      withOtp: true,
      timeout: '60s',
    });
  }

  async blockUser(id: string): Promise<void> {
    await this.call(
      'POST',
      `/v2/users/${encodeURIComponent(id)}/deactivate`,
      {},
    );
  }

  async unblockUser(id: string): Promise<void> {
    await this.call(
      'POST',
      `/v2/users/${encodeURIComponent(id)}/reactivate`,
      {},
    );
  }
}
