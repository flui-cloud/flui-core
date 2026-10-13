import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { resolveProviderBaseUrl } from '../../oidc/services/oidc-provider-admin.service';

export interface IdentityProviderConnection {
  pat: string;
  host: string;
}

export type IdentityEmailProviderState =
  | 'EMAIL_PROVIDER_ACTIVE'
  | 'EMAIL_PROVIDER_INACTIVE'
  | 'EMAIL_PROVIDER_STATE_UNSPECIFIED';

export interface IdentityEmailProvider {
  id: string;
  description: string;
  state: IdentityEmailProviderState;
  http: { endpoint: string; signingKey: string | null } | null;
}

/** Flui's own service account at the identity provider, and the Host it answers to. */
export function identityProviderConnection(
  env: NodeJS.ProcessEnv = process.env,
): IdentityProviderConnection | null {
  const pat = (env.ZITADEL_SERVICE_ACCOUNT_PAT ?? '').trim();
  const issuer = (env.OIDC_ISSUER ?? env.ZITADEL_ISSUER ?? '').trim();
  if (!pat || !issuer) return null;
  return { pat, host: issuer.replace(/^https?:\/\//, '').replace(/\/$/, '') };
}

function toProvider(raw: Record<string, unknown>): IdentityEmailProvider {
  const http = raw.http as
    | { endpoint?: string; signingKey?: string }
    | undefined;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    state:
      (raw.state as IdentityEmailProviderState) ??
      'EMAIL_PROVIDER_STATE_UNSPECIFIED',
    http: http
      ? { endpoint: http.endpoint ?? '', signingKey: http.signingKey || null }
      : null,
  };
}

@Injectable()
export class IdentityProviderEmailClient {
  constructor(private readonly http: HttpService) {}

  private headers(conn: IdentityProviderConnection): Record<string, string> {
    return {
      Authorization: `Bearer ${conn.pat}`,
      'Content-Type': 'application/json',
      Host: conn.host,
    };
  }

  private url(path: string): string {
    return `${resolveProviderBaseUrl()}/admin/v1${path}`;
  }

  async list(
    conn: IdentityProviderConnection,
  ): Promise<IdentityEmailProvider[]> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url('/email/_search'),
        {},
        { headers: this.headers(conn) },
      ),
    );
    const result = (resp.data?.result ?? []) as Record<string, unknown>[];
    return result.map(toProvider);
  }

  async addHttp(
    conn: IdentityProviderConnection,
    endpoint: string,
    description: string,
  ): Promise<{ id: string; signingKey: string }> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url('/email/http'),
        { endpoint, description },
        { headers: this.headers(conn) },
      ),
    );
    return { id: resp.data.id, signingKey: resp.data.signingKey };
  }

  async updateHttp(
    conn: IdentityProviderConnection,
    id: string,
    endpoint: string,
    description: string,
    rotateKey: boolean,
  ): Promise<{ signingKey: string | null }> {
    const resp = await firstValueFrom(
      this.http.put(
        this.url(`/email/http/${encodeURIComponent(id)}`),
        {
          endpoint,
          description,
          ...(rotateKey ? { expirationSigningKey: '0s' } : {}),
        },
        { headers: this.headers(conn) },
      ),
    );
    return { signingKey: resp.data?.signingKey || null };
  }

  async activate(conn: IdentityProviderConnection, id: string): Promise<void> {
    await firstValueFrom(
      this.http.post(
        this.url(`/email/${encodeURIComponent(id)}/_activate`),
        {},
        { headers: this.headers(conn) },
      ),
    );
  }
}
