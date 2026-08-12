import { Injectable, Logger } from '@nestjs/common';
import type { ProviderCredentials } from '@flui-cloud/mail';
import { AccessService } from '../../access/services/access.service';
import { CredentialPurpose } from '../../access/enums/credential-purpose.enum';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ScalewayIamAdapter } from '../../providers/implementations/scaleway/scaleway-iam.adapter';

/**
 * Where a mail driver's credential comes from.
 *
 * Scaleway Transactional Email rides on the compute secret key the user already
 * connected — the same arrangement `modules/inference` uses for Scaleway
 * inference, and object storage before it. Nothing extra to connect, which is
 * the whole reason Scaleway is the default: a user already on Scaleway gets
 * email without visiting a console.
 *
 * That only holds while the key's IAM policy covers Transactional Email, which
 * is a separate permission set. This resolver does not check — it hands over
 * what it has, and `MailReadinessService` asks the provider, which answers with
 * `permission_denied` rather than leaving it to be inferred from a 403.
 */
@Injectable()
export class MailCredentialsService {
  private readonly logger = new Logger(MailCredentialsService.name);

  constructor(
    private readonly accessService: AccessService,
    private readonly scalewayIam: ScalewayIamAdapter,
  ) {}

  async forScaleway(): Promise<ProviderCredentials> {
    const { secretKey } = await this.accessService.getActiveAccessKeyPair(
      CloudProvider.SCALEWAY,
      CredentialPurpose.COMPUTE,
    );
    return {
      provider: 'scaleway-tem',
      token: secretKey,
      projectId: await this.scalewayIam.getDefaultProjectId(),
    };
  }

  /**
   * Whether a Scaleway compute key is stored at all.
   *
   * A local read, deliberately: it answers "is Scaleway connected to Flui",
   * not "does that key still work", and the second question costs a round trip
   * to Scaleway IAM. This is called to decide whether to *show* the implicit
   * transactional sender, and a listing that waits on someone else's API is a
   * listing that hangs.
   */
  async hasScalewayCredential(): Promise<boolean> {
    try {
      await this.accessService.getActiveAccessKeyPair(
        CloudProvider.SCALEWAY,
        CredentialPurpose.COMPUTE,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Which project the calls are scoped to.
   *
   * Surfaced because it is the quiet failure of this integration: a domain
   * registered under one project is invisible to a key scoped to another, and
   * the API answers "no domains" rather than "wrong project". Showing it turns
   * a confusing empty list into an obvious mismatch.
   */
  async scalewayProjectId(): Promise<string | null> {
    try {
      return await this.scalewayIam.getDefaultProjectId();
    } catch (error) {
      this.logger.warn(
        `Could not resolve the Scaleway project id: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
