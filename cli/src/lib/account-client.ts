import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface AccountFactor {
  id: string;
  name: string;
  ready: boolean;
}

export interface AccountLink {
  idpId: string;
  provider: string;
  externalUserId: string;
  externalUserName: string;
}

export interface AccountOverview {
  profile: {
    userName: string;
    email: string | null;
    emailVerified: boolean;
    firstName: string | null;
    lastName: string | null;
    displayName: string | null;
  };
  security: {
    password: boolean;
    totp: boolean;
    passkeys: AccountFactor[];
    securityKeys: AccountFactor[];
    links: AccountLink[];
  };
  limits: { guest: boolean; canUnlink: boolean };
}

/**
 * The caller's own account; no call names a user, the API reads it from the
 * key. A key reads it and changes the name, nothing more.
 */
export class AccountClient {
  constructor(private readonly api: ApiClient) {}

  static fromConfig(profile?: string): AccountClient {
    const cfg = new ConfigStorage(profile);
    return new AccountClient(
      new ApiClient({
        baseUrl: cfg.getApiUrlOrThrow(),
        apiKey: cfg.getApiKeyOrThrow(),
      }),
    );
  }

  overview(): Promise<AccountOverview> {
    return this.api.get('/account');
  }

  updateProfile(change: {
    firstName: string;
    lastName: string;
    displayName?: string;
  }): Promise<AccountOverview['profile']> {
    return this.api.put('/account/profile', change);
  }
}
