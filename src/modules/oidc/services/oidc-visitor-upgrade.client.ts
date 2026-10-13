import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { resolveProviderBaseUrl } from './oidc-provider-admin.service';
import { statusOf } from './oidc-visitor-login.client';

export interface IdpIntentStart {
  /** The provider sends its intent id to GitHub or Google as the OAuth `state`. */
  intentId: string | null;
  authUrl: string;
}

/** What the provider learned from GitHub or Google, and whom that identity already belongs to. */
export interface IdpIntentResult {
  idpId: string;
  externalUserId: string;
  externalUserName: string;
  /** The account this identity is already linked to, if any. */
  linkedUserId: string | null;
  email: string | null;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
}

export interface VisitorProfile {
  givenName: string;
  familyName: string;
  displayName: string;
}

const VISITOR_METADATA_KEY = 'flui.visitor';

/**
 * The identity provider calls that turn a visitor into an account on the same
 * user: an external sign-in started and read back through the v2 intent API,
 * the identity linked, the address and names set, the visitor mark removed.
 */
@Injectable()
export class OidcVisitorUpgradeClient {
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

  async startIntent(
    pat: string,
    host: string,
    params: { idpId: string; successUrl: string; failureUrl: string },
  ): Promise<IdpIntentStart> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url('/v2/idp_intents'),
        {
          idpId: params.idpId,
          urls: {
            successUrl: params.successUrl,
            failureUrl: params.failureUrl,
          },
        },
        { headers: this.headers(pat, host) },
      ),
    );
    const authUrl = resp.data?.authUrl;
    if (typeof authUrl !== 'string' || !authUrl) {
      throw new Error('The identity provider returned no address to sign in');
    }
    return {
      intentId: text(resp.data?.intentId) ?? authUrlIntentId(authUrl),
      authUrl,
    };
  }

  async retrieveIntent(
    pat: string,
    host: string,
    intentId: string,
    token: string,
  ): Promise<IdpIntentResult> {
    const resp = await firstValueFrom(
      this.http.post(
        this.url(`/v2/idp_intents/${encodeURIComponent(intentId)}`),
        { idpIntentToken: token },
        { headers: this.headers(pat, host) },
      ),
    );
    const data = resp.data ?? {};
    const info = data.idpInformation ?? {};
    const human = data.addHumanUser ?? {};
    const email = text(human.email?.email);
    return {
      idpId: text(info.idpId) ?? '',
      externalUserId: text(info.userId) ?? '',
      externalUserName: text(info.userName) ?? '',
      linkedUserId: text(data.userId),
      email,
      emailVerified: !!email && human.email?.isVerified === true,
      givenName: text(human.profile?.givenName),
      familyName: text(human.profile?.familyName),
      displayName: text(human.profile?.displayName),
    };
  }

  async addIdpLink(
    pat: string,
    host: string,
    userId: string,
    link: { idpId: string; externalUserId: string; externalUserName: string },
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(
        this.url(`/v2/users/${encodeURIComponent(userId)}/links`),
        {
          idpLink: {
            idpId: link.idpId,
            userId: link.externalUserId,
            userName: link.externalUserName,
          },
        },
        { headers: this.headers(pat, host) },
      ),
    );
  }

  /** Undoes `addIdpLink`; a link already gone is not an error. */
  async removeIdpLink(
    pat: string,
    host: string,
    userId: string,
    link: { idpId: string; externalUserId: string },
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(
          this.url(
            `/v2/users/${encodeURIComponent(userId)}/links/${encodeURIComponent(link.idpId)}/${encodeURIComponent(link.externalUserId)}`,
          ),
          { headers: this.headers(pat, host) },
        ),
      );
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }

  /** Marked verified only when GitHub or Google said so; otherwise the provider asks the person. */
  async setEmail(
    pat: string,
    host: string,
    userId: string,
    email: string,
    verified: boolean,
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(
        this.url(`/v2/users/${encodeURIComponent(userId)}/email`),
        verified ? { email, isVerified: true } : { email, sendCode: {} },
        { headers: this.headers(pat, host) },
      ),
    );
  }

  async setProfile(
    pat: string,
    host: string,
    userId: string,
    profile: VisitorProfile,
  ): Promise<void> {
    await firstValueFrom(
      this.http.put(
        this.url(`/v2/users/human/${encodeURIComponent(userId)}`),
        { profile },
        { headers: this.headers(pat, host) },
      ),
    );
  }

  /** Removes the visitor mark; already removed is not an error. */
  async clearVisitorMark(
    pat: string,
    host: string,
    userId: string,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(
          this.url(
            `/management/v1/users/${encodeURIComponent(userId)}/metadata/${encodeURIComponent(VISITOR_METADATA_KEY)}`,
          ),
          { headers: this.headers(pat, host) },
        ),
      );
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function authUrlIntentId(authUrl: string): string | null {
  try {
    return new URL(authUrl).searchParams.get('state');
  } catch {
    return null;
  }
}
