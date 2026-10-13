import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import { OidcVisitorLoginClient } from '../../oidc/services/oidc-visitor-login.client';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { withAdvisoryLockWaiting } from '../../common/leadership/advisory-lock';
import { describeError } from '../../shared/utils/error.util';
import {
  SandboxVisitorLoginClientEntity,
  VISITOR_LOGIN_CLIENT_ROW,
} from '../entities/sandbox-visitor-login-client.entity';
import { ProviderConnection } from './provider-connection';
import { VISITOR_LOGIN_CLIENT_USERNAME } from './visitor.config';

export const LOGIN_CLIENT_ROLE = 'IAM_LOGIN_CLIENT';
export const LOGIN_CLIENT_TOKEN_LIFETIME_MS = 90 * 24 * 3_600_000;
export const LOGIN_CLIENT_RENEW_BEFORE_MS = 14 * 24 * 3_600_000;
const LOCK_NAME = 'sandbox-visitor-login-client';

/**
 * The one credential that can sign a visitor in. A machine account of its own
 * holding only the login-client role, so Flui's own service account is never
 * the thing that opens sessions, and this one can do nothing else. Read only by
 * the visitors' entrance. Its token expires, is renewed well before, and the
 * token it replaces is deleted at the provider.
 */
@Injectable()
export class VisitorLoginClientService {
  private readonly logger = new Logger(VisitorLoginClientService.name);
  private cached: string | null = null;

  constructor(
    private readonly admin: OidcProviderAdminClient,
    private readonly login: OidcVisitorLoginClient,
    private readonly encryption: EncryptionService,
    @InjectRepository(SandboxVisitorLoginClientEntity)
    private readonly rows: Repository<SandboxVisitorLoginClientEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Makes sure a working credential is stored; mints a new one when it is
   * missing, refused or close to its expiry. One copy of the API at a time,
   * so two never mint over each other.
   */
  ensure(conn: ProviderConnection, now = new Date()): Promise<void> {
    return withAdvisoryLockWaiting(this.dataSource, LOCK_NAME, () =>
      this.ensureHeld(conn, now),
    );
  }

  /** Renews the stored credential when it is close to its expiry; says whether it did. */
  async renewIfDue(
    conn: ProviderConnection,
    now = new Date(),
  ): Promise<boolean> {
    const row = await this.read();
    if (row && !due(row, now)) return false;
    await this.ensure(conn, now);
    return true;
  }

  /** The stored credential, or null until `ensure` has run once. */
  async token(): Promise<string | null> {
    if (this.cached) return this.cached;
    const row = await this.read();
    this.cached = row ? this.open(row) : null;
    return this.cached;
  }

  /** Keeps the "try" applications' client ids, so their tokens stay known once the entrance is shut. */
  async rememberTryClients(
    webClientId: string,
    cliClientId: string,
  ): Promise<void> {
    await this.rows.update(
      { id: VISITOR_LOGIN_CLIENT_ROW },
      { webClientId, cliClientId },
    );
  }

  forget(): void {
    this.cached = null;
  }

  private async ensureHeld(conn: ProviderConnection, now: Date): Promise<void> {
    const row = await this.read();
    if (row && !due(row, now)) {
      const pat = this.open(row);
      if (pat && (await this.login.acceptsToken(pat, conn.host))) {
        this.cached = pat;
        return;
      }
      this.logger.warn(
        'The visitors’ login credential was refused; minting a new one',
      );
    }

    const idpUserId = await this.account(conn);
    await this.login.addInstanceMember(conn.pat, conn.host, idpUserId, [
      LOGIN_CLIENT_ROLE,
    ]);
    const expiresAt = new Date(now.getTime() + LOGIN_CLIENT_TOKEN_LIFETIME_MS);
    const minted = await this.login.createPersonalAccessToken(
      conn.pat,
      conn.host,
      idpUserId,
      expiresAt,
    );
    await this.rows.save({
      id: VISITOR_LOGIN_CLIENT_ROW,
      idpUserId,
      patEncrypted: this.encryption.encrypt(minted.token),
      tokenId: minted.tokenId,
      expiresAt,
    });
    this.cached = minted.token;
    this.logger.log(
      `Visitors’ login credential ready (account ${idpUserId}, until ${expiresAt.toISOString()})`,
    );
    await this.retire(conn, idpUserId, minted.tokenId, row).catch(
      (error: unknown) =>
        this.logger.warn(
          `The visitors’ previous login credential was not deleted: ${describeError(error)}`,
        ),
    );
  }

  private async account(conn: ProviderConnection): Promise<string> {
    const existing = await this.admin.findUserByUsername(
      conn.pat,
      conn.host,
      VISITOR_LOGIN_CLIENT_USERNAME,
    );
    if (existing?.userName === VISITOR_LOGIN_CLIENT_USERNAME) {
      return existing.id;
    }
    const made = await this.admin.createMachineUser(conn.pat, conn.host, {
      userName: VISITOR_LOGIN_CLIENT_USERNAME,
      name: 'Flui visitor sign-in',
      description:
        'Signs demo visitors in for Flui. Holds only the login-client role.',
    });
    return made.id;
  }

  /** The token replaced goes; one stored before its id was kept is found among the account's tokens. */
  private async retire(
    conn: ProviderConnection,
    idpUserId: string,
    keep: string,
    previous: SandboxVisitorLoginClientEntity | null,
  ): Promise<void> {
    if (previous?.idpUserId !== idpUserId) return;
    const stale = previous.tokenId
      ? [previous.tokenId]
      : await this.login.listPersonalAccessTokenIds(
          conn.pat,
          conn.host,
          idpUserId,
        );
    await Promise.all(
      stale
        .filter((id) => id !== keep)
        .map((tokenId) =>
          this.login.deletePersonalAccessToken(
            conn.pat,
            conn.host,
            idpUserId,
            tokenId,
          ),
        ),
    );
  }

  private read(): Promise<SandboxVisitorLoginClientEntity | null> {
    return this.rows.findOne({ where: { id: VISITOR_LOGIN_CLIENT_ROW } });
  }

  private open(row: SandboxVisitorLoginClientEntity): string | null {
    try {
      return this.encryption.decrypt(row.patEncrypted);
    } catch {
      return null;
    }
  }
}

function due(row: SandboxVisitorLoginClientEntity, now: Date): boolean {
  if (!row.expiresAt) return true;
  return (
    new Date(row.expiresAt).getTime() - now.getTime() <=
    LOGIN_CLIENT_RENEW_BEFORE_MS
  );
}
