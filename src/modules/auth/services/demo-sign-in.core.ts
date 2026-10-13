import { ServiceUnavailableException } from '@nestjs/common';
import {
  LoginPolicy,
  SocialIdentityProviderKind,
} from '../../oidc/services/oidc-provider-admin.service';

export type SignInProviderKind = SocialIdentityProviderKind;

export type SignInProviderSource = 'flui' | 'environment' | 'identity-provider';

export const SIGN_IN_PROVIDER_KINDS: readonly SignInProviderKind[] = [
  'github',
  'google',
];

export const PROVIDERS: Record<
  SignInProviderKind,
  { name: string; envClientId: string; envClientSecret: string }
> = {
  github: {
    name: 'GitHub',
    envClientId: 'SANDBOX_GITHUB_CLIENT_ID',
    envClientSecret: 'SANDBOX_GITHUB_CLIENT_SECRET',
  },
  google: {
    name: 'Google',
    envClientId: 'SANDBOX_GOOGLE_CLIENT_ID',
    envClientSecret: 'SANDBOX_GOOGLE_CLIENT_SECRET',
  },
};

/** The identity provider's own address for the answer GitHub or Google sends back. */
export const CALLBACK_PATH = '/ui/login/login/externalidp/callback';

/** Where that answer goes when a visitor turns its visit into an account. */
export const INTENT_CALLBACK_PATH = '/idps/callback';

/**
 * What Flui remembers about a sign-in it connected. Never the secret: that is
 * handed to the identity provider once, which keeps it encrypted, and nothing
 * here can read it back.
 */
export interface SignInProviderRecord {
  clientId: string | null;
  idpId: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  disconnectedAt: string | null;
}

export interface SignInProviderStatus {
  provider: SignInProviderKind;
  name: string;
  connected: boolean;
  /**
   * `flui` once connected through Flui; `environment` while it still runs on
   * the deprecated variables; `identity-provider` when only the identity
   * provider still holds one those variables created before they were removed.
   */
  source: SignInProviderSource | null;
  clientId: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  disconnectedAt: string | null;
  onSignInPage: boolean;
}

export interface SignInProvidersView {
  demo: boolean;
  callbackUrl: string | null;
  intentCallbackUrl: string | null;
  providers: SignInProviderStatus[];
}

/** A sign-in a visitor can turn its visit into an account with. */
export interface UpgradeProvider {
  provider: SignInProviderKind;
  name: string;
  idpId: string;
}

export interface ProviderConnection {
  pat: string;
  host: string;
  issuer: string;
}

export interface ProviderState {
  policy: LoginPolicy;
  existing: Array<{ id: string; name: string; type: string }>;
}

export function connectionFrom(
  env: NodeJS.ProcessEnv,
): ProviderConnection | null {
  const pat = (env.ZITADEL_SERVICE_ACCOUNT_PAT ?? '').trim();
  const issuer = (env.OIDC_ISSUER ?? env.ZITADEL_ISSUER ?? '').trim();
  if (!pat || !issuer) return null;
  return { pat, host: issuer.replace(/^https?:\/\//, ''), issuer };
}

export function requireConnection(env: NodeJS.ProcessEnv): ProviderConnection {
  const conn = connectionFrom(env);
  if (!conn) {
    throw new ServiceUnavailableException(
      'The identity provider is not reachable from this API: there is no service account for it.',
    );
  }
  return conn;
}

export function callbackUrlOf(
  conn: ProviderConnection,
  path: string = CALLBACK_PATH,
): string {
  const base = conn.issuer.endsWith('/')
    ? conn.issuer.slice(0, -1)
    : conn.issuer;
  return `${base}${path}`;
}

export function envCredentials(
  env: NodeJS.ProcessEnv,
  kind: SignInProviderKind,
): { clientId: string; clientSecret: string } | null {
  const spec = PROVIDERS[kind];
  const clientId = (env[spec.envClientId] ?? '').trim();
  const clientSecret = env[spec.envClientSecret] ?? '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function currentIdpId(
  kind: SignInProviderKind,
  record: SignInProviderRecord | null,
  state: ProviderState,
): string | null {
  const recorded = record?.idpId;
  if (recorded && state.existing.some((p) => p.id === recorded)) {
    return recorded;
  }
  return (
    state.existing.find((p) => p.name === PROVIDERS[kind].name)?.id ?? null
  );
}

export function blankStatus(kind: SignInProviderKind): SignInProviderStatus {
  return {
    provider: kind,
    name: PROVIDERS[kind].name,
    connected: false,
    source: null,
    clientId: null,
    connectedAt: null,
    connectedBy: null,
    disconnectedAt: null,
    onSignInPage: false,
  };
}

export function statusOf(
  kind: SignInProviderKind,
  record: SignInProviderRecord | null,
  state: ProviderState,
  env: NodeJS.ProcessEnv,
): SignInProviderStatus {
  const status = blankStatus(kind);
  if (record) {
    const id = record.idpId;
    const present = !!id && state.existing.some((p) => p.id === id);
    return {
      ...status,
      connected: present,
      source: present ? 'flui' : null,
      clientId: record.clientId,
      connectedAt: record.connectedAt,
      connectedBy: record.connectedBy,
      disconnectedAt: record.disconnectedAt,
      onSignInPage: present && state.policy.idpIds.includes(id),
    };
  }
  const id = state.existing.find((p) => p.name === PROVIDERS[kind].name)?.id;
  if (!id) return status;
  const fromEnv = envCredentials(env, kind);
  return {
    ...status,
    connected: true,
    source: fromEnv ? 'environment' : 'identity-provider',
    clientId: fromEnv?.clientId ?? null,
    onSignInPage: state.policy.idpIds.includes(id),
  };
}
