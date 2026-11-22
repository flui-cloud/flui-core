export type IdentityUserState = 'active' | 'invited' | 'blocked' | 'locked';

export interface IdentityUser {
  id: string;
  username: string;
  email: string | null;
  state: IdentityUserState;
}

export interface IdentityClient {
  appId: string;
  clientId: string;
  clientSecret: string;
}

export interface NewIdentityClient {
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}

export interface InvitedUser {
  email: string;
  givenName: string;
  familyName: string;
}

/**
 * Everything Flui does with the identity server of a customer, and nothing
 * more: anything else is done in that server's own console.
 */
export interface IdentityPool {
  readonly issuer: string;
  ensureProject(name: string): Promise<string>;
  createClient(
    projectId: string,
    client: NewIdentityClient,
  ): Promise<IdentityClient>;
  deleteClient(projectId: string, appId: string): Promise<void>;
  listUsers(): Promise<IdentityUser[]>;
  inviteUser(user: InvitedUser): Promise<{ id: string }>;
  blockUser(id: string): Promise<void>;
  unblockUser(id: string): Promise<void>;
  /** Everything needed to rebuild the users elsewhere, password hashes and OTP secrets included; never passkeys. */
  exportUsers(): Promise<unknown>;
}
