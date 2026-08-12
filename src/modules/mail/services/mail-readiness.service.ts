import { Injectable, Logger } from '@nestjs/common';
import {
  ScalewayTemDriver,
  type MailReadiness,
  type SendScope,
} from '@flui-cloud/mail';
import { MailCredentialsService } from './mail-credentials.service';
import { MailProviderResolver } from './mail-provider.resolver';

/**
 * How far the platform is from being able to send.
 *
 * The point of asking the provider rather than trying a send and reading the
 * error: a refusal has several causes that look identical from the outside — a
 * key without the Transactional Email permission set, a domain registered in
 * another project, records still propagating — and each sends the operator
 * somewhere different. The driver turns those into named steps; this decides
 * what the platform does about them.
 */
@Injectable()
export class MailReadinessService {
  private readonly logger = new Logger(MailReadinessService.name);

  constructor(
    private readonly credentials: MailCredentialsService,
    private readonly providers: MailProviderResolver,
  ) {}

  async scaleway(
    domain?: string,
  ): Promise<MailReadiness & { projectId: string | null }> {
    const projectId = await this.credentials.scalewayProjectId();

    let credentials;
    try {
      credentials = await this.credentials.forScaleway();
    } catch (error) {
      // No connected Scaleway credential at all is itself a readiness answer,
      // and the earliest one — reporting it as a step keeps every caller on a
      // single shape instead of branching on an exception.
      this.logger.warn(
        `No Scaleway credential available: ${(error as Error).message}`,
      );
      return {
        provider: 'scaleway-tem',
        ready: false,
        projectId,
        steps: [
          {
            id: 'credential',
            status: 'manual',
            reason: 'not_connected',
            action:
              'Connect a Scaleway API key to Flui first — email reuses the compute key.',
          },
        ],
      };
    }

    const driver = new ScalewayTemDriver(credentials);
    const readiness = await driver.readiness(domain);
    return { ...readiness, projectId };
  }

  /**
   * Readiness for the provider actually carrying this scope.
   *
   * The console used to ask Scaleway unconditionally, which was true only while
   * Scaleway was the only provider there could be. With Brevo holding
   * transactional it reported on an account that is not sending — answering
   * `domain not_registered` about a domain the *live* provider knows perfectly
   * well, and sending whoever read it to fix a setup that was never in use.
   *
   * `projectId` survives because it is Scaleway's and it is real there; for
   * anyone else it is null rather than absent, so the shape does not fork.
   */
  async current(
    domain?: string,
    scope: SendScope = 'transactional',
  ): Promise<MailReadiness & { projectId: string | null }> {
    const { connection } = await this.providers.connectionFor(scope);
    if (connection.provider === 'scaleway-tem') return this.scaleway(domain);
    return { ...(await this.forScope(scope, domain)), projectId: null };
  }

  /**
   * Readiness for whichever provider carries this scope.
   *
   * A driver may offer none — the contract makes `readiness` optional because
   * it is a courtesy, not a promise. Rather than invent steps, that answers
   * with the one step every provider has: it either has a working credential
   * or it does not, and a send will say which.
   */
  async forScope(scope: SendScope, domain?: string): Promise<MailReadiness> {
    const driver = await this.providers.driverFor(scope);
    if (typeof driver.readiness === 'function') {
      return driver.readiness(domain);
    }
    return {
      provider: driver.id,
      ready: true,
      steps: [
        {
          id: 'credential',
          status: 'satisfied',
          reason: 'no_structured_readiness',
        },
      ],
    };
  }
}
