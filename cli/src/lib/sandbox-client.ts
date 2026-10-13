import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface SandboxTenancy {
  id: string;
  state: string;
  namespace: string;
  clusterId: string;
  claimedAt?: string | null;
  expiresAt?: string | null;
  reapedAt?: string | null;
  reapAttempts: number;
  lastError?: string | null;
  createdAt: string;
}

export type SignInProvider = 'github' | 'google';

export interface SignInProviderStatus {
  provider: SignInProvider;
  name: string;
  connected: boolean;
  source: 'flui' | 'environment' | 'identity-provider' | null;
  clientId: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  disconnectedAt: string | null;
  onSignInPage: boolean;
}

export interface SignInProviders {
  demo: boolean;
  callbackUrl: string | null;
  providers: SignInProviderStatus[];
}

/**
 * The guest areas of a demo instance, from the operator's side.
 *
 * Removing one used to mean opening the machine and deleting a namespace, which
 * skips the reaper — and the reaper is the only thing that also removes the
 * identity-provider account behind the area.
 */
export class SandboxClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): SandboxClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKeyOrThrow();
    return new SandboxClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  async listTenancies(): Promise<SandboxTenancy[]> {
    return this.api.get<SandboxTenancy[]>('/sandbox/tenancies');
  }

  /** `ref` is a namespace or an id — whichever the operator has in front of them. */
  async expire(ref: string): Promise<SandboxTenancy> {
    return this.api.post<SandboxTenancy>(
      `/sandbox/tenancies/${encodeURIComponent(ref)}/expire`,
    );
  }

  async listSignInProviders(): Promise<SignInProviders> {
    return this.api.get<SignInProviders>('/sandbox/sign-in/providers');
  }

  /** The secret travels in this one request body, to the identity provider, and nowhere else. */
  async connectSignInProvider(
    provider: SignInProvider,
    credentials: { clientId: string; clientSecret: string },
  ): Promise<SignInProviderStatus> {
    return this.api.put<SignInProviderStatus>(
      `/sandbox/sign-in/providers/${encodeURIComponent(provider)}`,
      credentials,
    );
  }

  async disconnectSignInProvider(
    provider: SignInProvider,
  ): Promise<SignInProviderStatus> {
    return this.api.delete<SignInProviderStatus>(
      `/sandbox/sign-in/providers/${encodeURIComponent(provider)}`,
    );
  }
}
