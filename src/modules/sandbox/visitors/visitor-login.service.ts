import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OidcVisitorLoginClient,
  statusOf,
} from '../../oidc/services/oidc-visitor-login.client';
import { describeError } from '../../shared/utils/error.util';
import { serviceConnection } from './provider-connection';
import { VisitorAdmissionService } from './visitor-admission.service';
import { VisitorLoginClientService } from './visitor-login-client.service';
import { VisitorPoolService } from './visitor-pool.service';
import { VisitorRefusalsService } from './visitor-refusals.service';
import {
  VISITOR_CLI_CLIENT_ENV,
  VISITOR_CLIENT_ENV,
  VISITOR_CONFIG,
  VisitorConfig,
  refusalUrl,
} from './visitor.config';

export type VisitorRefusal = 'closed' | 'invalid' | 'no-admission' | 'error';

const AUTH_REQUEST_ID = /^V2_[A-Za-z0-9_-]{1,128}$/;

/** Where the provider's sign-in of a "try" application lands, as `oidc_V2_…` or `V2_…`. */
export function authRequestIdOf(
  authRequest: string | undefined,
  requestId: string | undefined,
): string | null {
  const raw = (authRequest ?? requestId ?? '').replace(/^oidc_/, '');
  return AUTH_REQUEST_ID.test(raw) ? raw : null;
}

/**
 * The sign-in of the two "try" applications, done by Flui with no screen: the
 * provider hands over its auth request, Flui checks the admission ticket the
 * browser carried in `login_hint`, gives the request a ready visitor's session
 * and sends the browser on to the address the provider returns. Every other
 * answer is the dashboard's own sign-in page.
 */
@Injectable()
export class VisitorLoginService {
  private readonly logger = new Logger(VisitorLoginService.name);

  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    private readonly login: OidcVisitorLoginClient,
    private readonly loginClient: VisitorLoginClientService,
    private readonly admissions: VisitorAdmissionService,
    private readonly pool: VisitorPoolService,
    private readonly refusals: VisitorRefusalsService,
  ) {}

  async enter(
    authRequestId: string | null,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<string> {
    if (!this.config.enabled) return this.refuse('closed');
    if (!authRequestId) return this.refuse('invalid');
    const conn = serviceConnection(env);
    const pat = await this.loginClient.token().catch(() => null);
    if (!conn || !pat) return this.refuse('closed');

    try {
      const request = await this.login.getAuthRequest(
        pat,
        conn.host,
        authRequestId,
      );
      const cli = this.clientKind(request.clientId, env);
      if (cli === null) return this.refuse('invalid');

      const admission = await this.admissions.consume(request.loginHint, cli);
      if (!admission) return this.refuse('no-admission');

      const started = Date.now();
      const visitor = await this.pool.enter(admission.ipHash);
      const callbackUrl = await this.login.createCallback(
        pat,
        conn.host,
        authRequestId,
        visitor.session,
      );
      this.logger.log(
        `Visitor ${visitor.userId} signed in through ${cli ? 'the CLI' : 'the browser'} (${visitor.fromPool ? 'ready' : 'made on the spot'}, ${Date.now() - started} ms)`,
      );
      return callbackUrl;
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        this.loginClient.forget();
        void this.loginClient
          .ensure(conn)
          .catch((e: unknown) =>
            this.logger.warn(
              `Login credential not renewed: ${describeError(e)}`,
            ),
          );
      }
      this.logger.warn(
        `A visitor could not be signed in: ${describeError(error)}`,
      );
      return this.refuse('error');
    }
  }

  private clientKind(clientId: string, env: NodeJS.ProcessEnv): boolean | null {
    if (!clientId) return null;
    if (clientId === env[VISITOR_CLIENT_ENV]) return false;
    if (clientId === env[VISITOR_CLI_CLIENT_ENV]) return true;
    return null;
  }

  private async refuse(reason: VisitorRefusal): Promise<string> {
    await this.refusals.note(reason);
    return refusalUrl(this.config, reason);
  }
}
