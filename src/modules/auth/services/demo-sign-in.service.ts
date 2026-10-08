import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import { describeError } from '../../shared/utils/error.util';

interface SocialProvider {
  kind: 'github' | 'google';
  name: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * On a demo instance anyone may sign in: with an email they register
 * themselves, or with GitHub or Google. Applied on every start, because the
 * identity provider is configured once at install and a demo is switched on
 * later; idempotent, and never allowed to stop the API from starting.
 */
@Injectable()
export class DemoSignInService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoSignInService.name);

  constructor(private readonly oidc: OidcProviderAdminClient) {}

  onApplicationBootstrap(): void {
    if (process.env.SANDBOX_ENABLED !== 'true') return;
    void this.apply().catch((error: unknown) =>
      this.logger.warn(`Could not open demo sign-in: ${describeError(error)}`),
    );
  }

  /** Returns the providers it had to add, for the log and the tests. */
  async apply(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const pat = (env.ZITADEL_SERVICE_ACCOUNT_PAT ?? '').trim();
    const issuer = (env.OIDC_ISSUER ?? env.ZITADEL_ISSUER ?? '').trim();
    if (!pat || !issuer) {
      this.logger.warn(
        'Demo sign-in not configured: the identity provider is not reachable from here',
      );
      return [];
    }
    const host = issuer.replace(/^https?:\/\//, '');

    const policy = await this.oidc.getLoginPolicy(pat, host);
    if (policy.isDefault || !policy.allowRegister || !policy.allowExternalIdp) {
      await this.oidc.openSelfRegistration(pat, host, policy);
    }

    const wanted: SocialProvider[] = [
      {
        kind: 'github',
        name: 'GitHub',
        clientId: env.SANDBOX_GITHUB_CLIENT_ID,
        clientSecret: env.SANDBOX_GITHUB_CLIENT_SECRET,
      },
      {
        kind: 'google',
        name: 'Google',
        clientId: env.SANDBOX_GOOGLE_CLIENT_ID,
        clientSecret: env.SANDBOX_GOOGLE_CLIENT_SECRET,
      },
    ];
    const existing = await this.oidc.listIdentityProviders(pat, host);
    const linked = new Set(policy.idpIds);
    const added: string[] = [];

    for (const provider of wanted) {
      if (!provider.clientId || !provider.clientSecret) continue;
      let id = existing.find((p) => p.name === provider.name)?.id;
      if (!id) {
        id = await this.oidc.addSocialIdentityProvider(
          pat,
          host,
          provider.kind,
          {
            name: provider.name,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
          },
        );
        added.push(provider.name);
      }
      if (!linked.has(id)) {
        await this.oidc.addIdentityProviderToLogin(pat, host, id);
      }
    }

    this.logger.log(
      `Demo sign-in open: self-registration on${
        added.length ? `, added ${added.join(' and ')}` : ''
      }`,
    );
    return added;
  }
}
