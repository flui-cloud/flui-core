import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { withAdvisoryLockWaiting } from '../../common/leadership/advisory-lock';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import {
  OidcVisitorLoginClient,
  TryAppSpec,
} from '../../oidc/services/oidc-visitor-login.client';
import { FLUI_CLI_REDIRECT_URIS } from '../../auth/services/oidc-bootstrap.service';
import { describeError } from '../../shared/utils/error.util';
import { ProviderConnection, serviceConnection } from './provider-connection';
import { VisitorLoginClientService } from './visitor-login-client.service';
import {
  VISITOR_CLI_APP_NAME,
  VISITOR_CLI_CLIENT_ENV,
  VISITOR_CLIENT_ENV,
  VISITOR_CONFIG,
  VISITOR_LOGIN_PATH,
  VISITOR_WEB_APP_NAME,
  VisitorConfig,
} from './visitor.config';

const FLUI_PROJECT_NAME = 'Flui';
const LOCK_NAME = 'sandbox-visitor-entrance';

/**
 * Prepares the identity provider for visitors on every start: the login-client
 * credential and the two "try" applications whose sign-in is handed to Flui.
 * Idempotent, one copy of the API at a time, and never allowed to stop the API
 * from starting.
 */
@Injectable()
export class VisitorEntranceSetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VisitorEntranceSetupService.name);

  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    private readonly admin: OidcProviderAdminClient,
    private readonly login: OidcVisitorLoginClient,
    private readonly loginClient: VisitorLoginClientService,
    private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) return;
    void this.setUp().catch((error: unknown) =>
      this.logger.warn(
        `Could not prepare the visitors’ entrance: ${describeError(error)}`,
      ),
    );
  }

  async setUp(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    const conn = serviceConnection(env);
    if (!conn) {
      this.logger.warn(
        'Visitors’ entrance not prepared: the identity provider is not reachable from here',
      );
      return false;
    }
    return withAdvisoryLockWaiting(this.dataSource, LOCK_NAME, async () => {
      await this.loginClient.ensure(conn);
      return this.ensureApps(conn, env);
    });
  }

  private async ensureApps(
    conn: ProviderConnection,
    env: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    const project = await this.admin.findProjectByName(
      conn.pat,
      conn.host,
      FLUI_PROJECT_NAME,
    );
    if (!project) {
      this.logger.warn(
        'Visitors’ entrance not prepared: no Flui project at the identity provider',
      );
      return false;
    }
    const loginBaseUri = `${this.config.apiBase}${VISITOR_LOGIN_PATH}`;
    const origin = this.config.dashboardOrigin;
    const web = await this.ensureApp(conn, project.id, {
      name: VISITOR_WEB_APP_NAME,
      kind: 'web',
      redirectUris: [`${origin}/auth/callback`],
      postLogoutRedirectUris: [origin, `${origin}/login?loggedOut=true`],
      devMode: [origin, loginBaseUri].some((u) => u.startsWith('http://')),
      loginBaseUri,
    });
    const cli = await this.ensureApp(conn, project.id, {
      name: VISITOR_CLI_APP_NAME,
      kind: 'cli',
      redirectUris: FLUI_CLI_REDIRECT_URIS,
      postLogoutRedirectUris: [],
      devMode: true,
      loginBaseUri,
    });
    env[VISITOR_CLIENT_ENV] = web;
    env[VISITOR_CLI_CLIENT_ENV] = cli;
    await this.loginClient.rememberTryClients(web, cli);
    this.logger.log(
      `Visitors’ entrance ready: ${VISITOR_WEB_APP_NAME} ${web}, ${VISITOR_CLI_APP_NAME} ${cli}, sign-in at ${loginBaseUri}/login`,
    );
    return true;
  }

  private async ensureApp(
    conn: ProviderConnection,
    projectId: string,
    spec: TryAppSpec,
  ): Promise<string> {
    const found = await this.admin.findOidcAppByName(
      conn.pat,
      conn.host,
      projectId,
      spec.name,
    );
    const app = await this.login.ensureTryApp(
      conn.pat,
      conn.host,
      projectId,
      spec,
      found ? { appId: found.appId, clientId: found.clientId } : null,
    );
    return app.clientId;
  }
}
