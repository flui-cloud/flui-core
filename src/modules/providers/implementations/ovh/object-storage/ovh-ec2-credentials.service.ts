import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudProvider } from '../../../enums/cloud-provider.enum';
import { ICredentialProvider } from '../../../interfaces/credential-provider.interface';
import { resolveOvhProjectId } from '../ovh-openstack-client.factory';

const DEFAULT_AUTH_URL = 'https://auth.cloud.ovh.net/v3';
const DEFAULT_DOMAIN = 'Default';

export interface OvhS3KeyPair {
  accessKey: string;
  secretKey: string;
  /** True when an existing credential was reused rather than a new one minted. */
  reused: boolean;
}

interface KeystoneEc2Credential {
  access: string;
  secret: string;
  tenant_id: string;
}

/**
 * OVH stores an OpenStack username/password, but its object storage speaks S3
 * with SigV4. Keystone bridges the two: it mints an access/secret pair from the
 * very credential Flui already holds, so an OVH backup destination needs no
 * second credential from the customer — unlike DNS and the managed firewall,
 * which live on OVH's own API and do.
 */
@Injectable()
export class OvhEc2CredentialsService {
  private readonly logger = new Logger(OvhEc2CredentialsService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {}

  async hasComputeCredential(): Promise<boolean> {
    try {
      const { accessKey, secretKey } =
        await this.credentialProvider.getActiveAccessKeyPair(CloudProvider.OVH);
      return Boolean(accessKey && secretKey);
    } catch {
      return false;
    }
  }

  /**
   * Reuses the project's existing EC2 credential when there is one, and mints
   * one only otherwise. Keystone returns the secret on list, which is what
   * makes reuse possible — without it every provisioning retry would leave
   * another live key behind on the account.
   *
   * Deliberately never revokes: Keystone EC2 credentials carry no metadata, so
   * a credential the customer created for their own tooling is
   * indistinguishable from one of ours. Revoking on our schedule could break
   * something we cannot see.
   */
  async ensureS3KeyPair(): Promise<OvhS3KeyPair> {
    const { authUrl, token, userId, projectId } = await this.scopedAuth();
    const base = `${authUrl}/users/${encodeURIComponent(userId)}/credentials/OS-EC2`;

    const existing = await this.list(base, token, projectId);
    if (existing) {
      return {
        accessKey: existing.access,
        secretKey: existing.secret,
        reused: true,
      };
    }

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'x-auth-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_id: projectId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `OVH refused to create an S3 credential: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as { credential: KeystoneEc2Credential };
    this.logger.log('Minted a new OVH S3 credential for object storage');
    return {
      accessKey: body.credential.access,
      secretKey: body.credential.secret,
      reused: false,
    };
  }

  private async list(
    base: string,
    token: string,
    projectId: string,
  ): Promise<KeystoneEc2Credential | undefined> {
    const res = await fetch(base, { headers: { 'x-auth-token': token } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      credentials?: KeystoneEc2Credential[];
    };
    const usable = (body.credentials ?? [])
      .filter((c) => c.tenant_id === projectId && c.access && c.secret)
      .sort((a, b) => a.access.localeCompare(b.access));
    return usable[0];
  }

  private async scopedAuth(): Promise<{
    authUrl: string;
    token: string;
    userId: string;
    projectId: string;
  }> {
    const { accessKey: username, secretKey: password } =
      await this.credentialProvider.getActiveAccessKeyPair(CloudProvider.OVH);
    const authUrl = this.configService
      .get<string>('OVH_OS_AUTH_URL', DEFAULT_AUTH_URL)
      .replace(/\/$/, '');
    const userDomain = this.configService.get<string>(
      'OVH_OS_USER_DOMAIN_NAME',
      DEFAULT_DOMAIN,
    );
    const projectId = await resolveOvhProjectId(
      authUrl,
      username,
      password,
      userDomain,
    );

    const res = await fetch(`${authUrl}/auth/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        auth: {
          identity: {
            methods: ['password'],
            password: {
              user: { name: username, domain: { name: userDomain }, password },
            },
          },
          scope: { project: { id: projectId } },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(
        `OVH OpenStack authentication failed: HTTP ${res.status}`,
      );
    }
    const token = res.headers.get('x-subject-token');
    if (!token) {
      throw new Error('OVH OpenStack authentication returned no token.');
    }
    const body = (await res.json()) as { token: { user: { id: string } } };
    return { authUrl, token, userId: body.token.user.id, projectId };
  }
}
