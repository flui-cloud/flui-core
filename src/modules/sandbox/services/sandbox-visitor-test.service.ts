import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import { OidcVisitorLoginClient } from '../../oidc/services/oidc-visitor-login.client';
import { ApiKeyService } from '../../auth/services/api-key.service';
import { expandPermissionGroups } from '../../auth/constants/api-key-groups';
import { orderScopes } from '../../auth/constants/api-key-scopes';
import { describeError } from '../../shared/utils/error.util';
import { serviceConnection } from '../visitors/provider-connection';
import { visitorIdentity, writeVisitorRows } from '../visitors/visitor-rows';

export const VISITOR_TEST_ROUTE_ENV = 'SANDBOX_VISITOR_TEST_ROUTE';

export const VISITOR_KEY_GROUPS = ['apps:look', 'observability:look'];

const KEY_LIFETIME_MS = 24 * 3_600_000;

export interface CreatedTestVisitor {
  userId: string;
  idpUserId: string;
  username: string;
  apiKey: string;
  groups: string[];
}

export function visitorTestRouteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[VISITOR_TEST_ROUTE_ENV] === 'true';
}

/**
 * Makes one visitor the way the entrance will, without the entrance: an
 * identity-provider account, the local person of kind `visitor` with its two
 * grants, and a reading key to act as it. For checking the visitor's limits
 * on a live instance before the entrance exists.
 */
@Injectable()
export class SandboxVisitorTestService {
  private readonly logger = new Logger(SandboxVisitorTestService.name);

  constructor(
    private readonly oidc: OidcProviderAdminClient,
    private readonly login: OidcVisitorLoginClient,
    private readonly apiKeys: ApiKeyService,
    private readonly dataSource: DataSource,
  ) {}

  async create(): Promise<CreatedTestVisitor> {
    const conn = serviceConnection();
    if (!conn) {
      throw new ServiceUnavailableException(
        'The identity provider is not reachable from this API: there is no service account for it.',
      );
    }
    const { pat, host } = conn;
    const { userName: username, email } = visitorIdentity(randomUUID());
    const idpUserId = await this.login.createHuman(pat, host, {
      userName: username,
      email,
    });

    let userId: string;
    try {
      userId = await this.dataSource.transaction((m) =>
        writeVisitorRows(m, { idpUserId, email, ipHash: null }),
      );
    } catch (error) {
      await this.oidc
        .deleteUser(pat, host, idpUserId)
        .catch((cleanup: unknown) =>
          this.logger.warn(
            `Could not remove visitor ${idpUserId} at the identity provider: ${describeError(cleanup)}`,
          ),
        );
      throw error;
    }

    const { scopes } = expandPermissionGroups(VISITOR_KEY_GROUPS);
    const { plaintext } = await this.apiKeys.generateApiKey(
      `${username} (test)`,
      userId,
      new Date(Date.now() + KEY_LIFETIME_MS),
      orderScopes(scopes),
    );
    this.logger.log(`Test visitor ${userId} created (${username})`);
    return {
      userId,
      idpUserId,
      username,
      apiKey: plaintext,
      groups: VISITOR_KEY_GROUPS,
    };
  }
}
