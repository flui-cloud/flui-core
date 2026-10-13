import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, Repository } from 'typeorm';
import {
  withAdvisoryLock,
  withAdvisoryLockWaiting,
} from '../../common/leadership/advisory-lock';
import { KeyStorageService } from '../../access/services/key-storage.service';
import { IN_CLUSTER_API_URL } from '../../dns/utils/gateway-forward-auth-address.util';
import {
  IDENTITY_EMAIL_ROW_ID,
  IdentityEmailProviderEntity,
  IdentityEmailReason,
} from '../entities/identity-email-provider.entity';
import {
  IdentityProviderConnection,
  IdentityProviderEmailClient,
  identityProviderConnection,
} from './identity-provider-email.client';
import { MailProviderResolver } from './mail-provider.resolver';
import { MailReadinessService } from './mail-readiness.service';
import { IdentityEmailDedupeService } from './identity-email-dedupe.service';
import { describeError } from '../utils/mail-error.util';

export const IDENTITY_EMAIL_PATH = '/api/v1/identity/email';
export const IDENTITY_EMAIL_DESCRIPTION = 'Flui mail';
const LOCK_NAME = 'mail-identity-email-provider';

export type IdentityEmailState =
  | 'active'
  | 'attention'
  | 'not_configured'
  | 'error';

export interface IdentityEmailStatus {
  state: IdentityEmailState;
  reason: IdentityEmailReason | null;
  mailProvider: string | null;
  providerId: string | null;
  active: boolean;
  endpoint: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastDeliveryAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface IdentitySender {
  email: string;
  name: string;
  provider: string;
}

/**
 * Where the identity provider should post its mail: the API's in-cluster
 * address when this copy runs inside the cluster (the identity provider runs
 * beside it and accepts plain http), an explicit override otherwise, and
 * nothing at all from a workstation, so a local API never repoints a live
 * identity provider at itself.
 */
export function identityEmailEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = (env.IDENTITY_EMAIL_ENDPOINT ?? '').trim();
  if (override) return override;
  if (!env.KUBERNETES_SERVICE_HOST) return null;
  return `${IN_CLUSTER_API_URL}${IDENTITY_EMAIL_PATH}`;
}

/**
 * Keeps the identity provider's email going through Flui: one HTTP email
 * provider at the identity provider, pointing at Flui, its signing key sealed
 * here. With no transactional sender ready it leaves the identity provider as
 * it is and says why.
 */
@Injectable()
export class IdentityEmailSetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdentityEmailSetupService.name);

  constructor(
    @InjectRepository(IdentityEmailProviderEntity)
    private readonly repo: Repository<IdentityEmailProviderEntity>,
    private readonly client: IdentityProviderEmailClient,
    private readonly providers: MailProviderResolver,
    private readonly readiness: MailReadinessService,
    private readonly keys: KeyStorageService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly dedupe: IdentityEmailDedupeService,
  ) {}

  onApplicationBootstrap(): void {
    void this.ensureQuietly();
  }

  @Cron(process.env.MAIL_IDENTITY_SYNC_CRON || CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    await this.dedupe.purge().catch(() => undefined);
    await this.ensureQuietly();
  }

  /** Converge if no other copy of the API is already doing it. Never throws. */
  async ensureQuietly(): Promise<void> {
    try {
      await withAdvisoryLock(this.dataSource, LOCK_NAME, () => this.converge());
    } catch (error) {
      this.logger.warn(
        `[mail] identity email provider not synced: ${describeError(error)}`,
      );
    }
  }

  async sync(): Promise<IdentityEmailStatus> {
    await withAdvisoryLockWaiting(this.dataSource, LOCK_NAME, () =>
      this.converge(),
    );
    return this.status();
  }

  async status(): Promise<IdentityEmailStatus> {
    const row = await this.row();
    const mailProvider = await this.providers
      .connectionFor('transactional')
      .then((r) => r.connection.provider as string)
      .catch(() => null);
    return {
      state: stateOf(row),
      reason: row?.reason ?? null,
      mailProvider,
      providerId: row?.providerId ?? null,
      active: row?.active ?? false,
      endpoint: row?.endpoint ?? null,
      lastSyncAt: iso(row?.lastSyncAt),
      lastSyncError: row?.lastSyncError ?? null,
      lastDeliveryAt: iso(row?.lastDeliveryAt),
      lastErrorAt: iso(row?.lastErrorAt),
      lastError: row?.lastError ?? null,
    };
  }

  async signingKey(): Promise<string | null> {
    const row = await this.row();
    if (!row?.encryptedSigningKey) return null;
    try {
      return this.keys.decryptKeyFromString(row.encryptedSigningKey);
    } catch {
      return null;
    }
  }

  /**
   * Who sign-in mail is sent from, through which provider: `MAIL_FROM` when
   * set, otherwise `noreply@` the transactional connection's sending domain.
   */
  async sender(): Promise<IdentitySender | { reason: IdentityEmailReason }> {
    let resolved;
    try {
      resolved = await this.providers.connectionFor('transactional');
    } catch {
      return { reason: 'no_transactional_connection' };
    }
    const configured = this.config.get<string>('MAIL_FROM')?.trim();
    const domain = resolved.connection.sendingDomain?.trim();
    const email = configured || (domain ? `noreply@${domain}` : '');
    if (!email) return { reason: 'no_sender' };
    return {
      email,
      name: this.config.get<string>('MAIL_FROM_NAME')?.trim() || 'Flui',
      provider: resolved.connection.provider,
    };
  }

  async recordDelivery(): Promise<void> {
    await this.patch({ lastDeliveryAt: new Date(), reason: null });
  }

  async recordFailure(
    message: string,
    reason?: IdentityEmailReason,
  ): Promise<void> {
    await this.patch({
      lastErrorAt: new Date(),
      lastError: message.slice(0, 500),
      ...(reason ? { reason } : {}),
    });
  }

  private async converge(): Promise<void> {
    const conn = identityProviderConnection();
    if (!conn) return this.leave('identity_provider_unreachable');
    const endpoint = identityEmailEndpoint();
    if (!endpoint) return this.leave('endpoint_unknown');

    const sender = await this.sender();
    if ('reason' in sender) return this.leave(sender.reason);
    if (!(await this.senderReady(sender.email))) {
      return this.leave('sender_not_ready');
    }

    try {
      await this.ensureProvider(conn, endpoint);
    } catch (error) {
      const message = describeError(error);
      this.logger.warn(
        `[mail] identity email provider sync failed: ${message}`,
      );
      await this.patch({
        reason: 'sync_failed',
        lastSyncAt: new Date(),
        lastSyncError: message.slice(0, 500),
      });
    }
  }

  private async senderReady(email: string): Promise<boolean> {
    try {
      const domain = email.split('@')[1];
      return (await this.readiness.current(domain, 'transactional')).ready;
    } catch {
      return false;
    }
  }

  private async ensureProvider(
    conn: IdentityProviderConnection,
    endpoint: string,
  ): Promise<void> {
    const row = await this.row();
    const all = await this.client.list(conn);
    const found =
      all.find((p) => p.id === row?.providerId && p.http) ??
      all.find((p) => p.http && p.description === IDENTITY_EMAIL_DESCRIPTION) ??
      null;

    let providerId: string;
    let signingKey: string | null;
    let active = false;

    if (!found) {
      const added = await this.client.addHttp(
        conn,
        endpoint,
        IDENTITY_EMAIL_DESCRIPTION,
      );
      providerId = added.id;
      signingKey = added.signingKey;
      this.logger.log(`[mail] identity email provider ${providerId} created`);
    } else {
      providerId = found.id;
      active = found.state === 'EMAIL_PROVIDER_ACTIVE';
      signingKey = found.http?.signingKey ?? (await this.signingKey());
      const moved = found.http?.endpoint !== endpoint;
      if (moved || !signingKey) {
        const updated = await this.client.updateHttp(
          conn,
          providerId,
          endpoint,
          IDENTITY_EMAIL_DESCRIPTION,
          !signingKey,
        );
        signingKey = updated.signingKey ?? signingKey;
      }
    }
    if (!signingKey) {
      throw new Error('the identity provider returned no signing key');
    }
    if (!active) await this.client.activate(conn, providerId);

    await this.patch({
      providerId,
      endpoint,
      encryptedSigningKey: this.keys.encryptKeyToString(signingKey),
      active: true,
      reason: null,
      lastSyncAt: new Date(),
      lastSyncError: null,
    });
  }

  private async leave(reason: IdentityEmailReason): Promise<void> {
    await this.patch({ reason, lastSyncAt: new Date() });
  }

  private row(): Promise<IdentityEmailProviderEntity | null> {
    return this.repo.findOne({ where: { id: IDENTITY_EMAIL_ROW_ID } });
  }

  private async patch(
    fields: Partial<IdentityEmailProviderEntity>,
  ): Promise<void> {
    await this.repo.upsert({ id: IDENTITY_EMAIL_ROW_ID, ...fields }, ['id']);
  }
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function stateOf(row: IdentityEmailProviderEntity | null): IdentityEmailState {
  if (!row) return 'not_configured';
  if (row.reason === 'sync_failed') return 'error';
  if (row.active) return row.reason ? 'attention' : 'active';
  return 'not_configured';
}
