import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface IdentityUser {
  id: string;
  username: string;
  email: string | null;
  state: 'active' | 'invited' | 'blocked' | 'locked';
}

export interface IdentityInstall {
  identityInstallId: string;
  applicationId: string;
  name: string;
  issuer: string | null;
  managed: boolean;
}

export interface IdentityEnvNames {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface AppIdentityLink {
  applicationId: string;
  identityInstallId: string;
  issuer: string;
  clientId: string;
  redirectUris: string[];
  envNames: Required<IdentityEnvNames>;
}

/** Sign-in for the users of a customer's apps, on an identity install of theirs. */
export class IdentityClient {
  constructor(private readonly api: ApiClient) {}

  static fromConfig(): IdentityClient {
    const cfg = new ConfigStorage();
    return new IdentityClient(
      new ApiClient({
        baseUrl: cfg.getApiUrlOrThrow(),
        apiKey: cfg.getApiKeyOrThrow(),
      }),
    );
  }

  installs(): Promise<IdentityInstall[]> {
    return this.api.get('/identity/installs');
  }

  users(installId: string): Promise<IdentityUser[]> {
    return this.api.get(
      `/identity/installs/${encodeURIComponent(installId)}/users`,
    );
  }

  invite(
    installId: string,
    person: { email: string; givenName: string; familyName: string },
  ): Promise<{ id: string }> {
    return this.api.post(
      `/identity/installs/${encodeURIComponent(installId)}/users`,
      person,
    );
  }

  exportUsers(installId: string): Promise<unknown> {
    return this.api.post(
      `/identity/installs/${encodeURIComponent(installId)}/export`,
    );
  }

  setBlocked(
    installId: string,
    userId: string,
    blocked: boolean,
  ): Promise<void> {
    return this.api.post(
      `/identity/installs/${encodeURIComponent(installId)}/users/${encodeURIComponent(userId)}/${blocked ? 'block' : 'unblock'}`,
    );
  }

  link(applicationId: string): Promise<AppIdentityLink | null> {
    return this.api.get(
      `/applications/${encodeURIComponent(applicationId)}/identity`,
    );
  }

  connect(
    applicationId: string,
    body: {
      identityInstallId: string;
      redirectPaths: string[];
      envNames?: IdentityEnvNames;
    },
  ): Promise<AppIdentityLink> {
    return this.api.put(
      `/applications/${encodeURIComponent(applicationId)}/identity`,
      body,
    );
  }

  disconnect(applicationId: string): Promise<void> {
    return this.api.delete(
      `/applications/${encodeURIComponent(applicationId)}/identity`,
    );
  }
}
