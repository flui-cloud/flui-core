import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import {
  EgressPolicy,
  egressPolicyFromEnv,
  guardedRequest,
  isAllowedHost,
} from '../../../common/net/egress-guard';
import { UserEntity } from '../../auth/entities/user.entity';
import { UserEventsGateway } from '../../auth/gateway/user-events.gateway';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AlertDestinationEntity } from '../entities/alert-destination.entity';
import { AlertEventEntity } from '../entities/alert-event.entity';
import { AlertMailService } from './alert-mail.service';
import { alertDashboardLink } from './alert-mail.template';
import { meetsFloor, signAlertWebhook } from './alert-routing.util';

export type AlertDeliveryKind = 'fired' | 'resolved';

export interface AlertRoutingSubject {
  /** The owner of the application the alert is about, when it has one. */
  ownerUserId?: string | null;
}

export interface AlertDeliveryOutcome {
  ok: boolean;
  status: string | null;
  error: string | null;
}

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * The one place an alert transition is delivered: the bell, the built-in
 * email, and every destination somebody added. Alertmanager's webhook calls
 * it, and so can anything else that has news of its own.
 *
 * Never throws. An alert that could not reach one destination is still an
 * alert for the others, and the caller is usually answering somebody else's
 * request.
 */
@Injectable()
export class AlertRoutingService {
  private readonly logger = new Logger(AlertRoutingService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(AlertDestinationEntity)
    private readonly destinations: Repository<AlertDestinationEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly mail: AlertMailService,
    private readonly encryption: EncryptionService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async deliver(
    kind: AlertDeliveryKind,
    event: AlertEventEntity,
    subject: AlertRoutingSubject = {},
  ): Promise<void> {
    const ownerUserId = subject.ownerUserId ?? null;
    // Anything with an application or an owner is a tenant's news, and only a
    // destination somebody with data access widened to `all` hears it.
    const infrastructure = !event.applicationId && !ownerUserId;
    const rows = await this.enabledRows();
    const admins = rows.find((r) => r.kind === 'admins');

    await Promise.allSettled([
      this.ring(kind, event, ownerUserId),
      this.mail.deliver(kind, event, {
        ownerUserId,
        adminWarnings: admins?.minSeverity === 'warning',
      }),
      ...rows
        .filter((r) => r.kind === 'email' || r.kind === 'webhook')
        .filter((r) => meetsFloor(event.severity, r.minSeverity))
        .filter((r) => r.scope === 'all' || infrastructure)
        .map((r) => this.sendTo(r, kind, event)),
    ]);
  }

  /** One destination, whatever its floor, with the outcome recorded on it. */
  async sendTo(
    destination: AlertDestinationEntity,
    kind: AlertDeliveryKind,
    event: AlertEventEntity,
  ): Promise<AlertDeliveryOutcome> {
    let outcome: AlertDeliveryOutcome;
    try {
      outcome =
        destination.kind === 'webhook'
          ? await this.post(destination, kind, event)
          : await this.email(destination, kind, event);
    } catch (error) {
      outcome = {
        ok: false,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!outcome.ok) {
      this.logger.warn(
        `Alert ${event.alertname} not delivered to ${destination.kind} ${destination.id}: ${outcome.error}`,
      );
    }
    try {
      await this.destinations.update(destination.id, {
        lastDeliveryAt: new Date(),
        lastStatus: outcome.status,
        lastError: outcome.error?.slice(0, 500) ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Could not record delivery on ${destination.id}: ${(error as Error).message}`,
      );
    }
    return outcome;
  }

  private async enabledRows(): Promise<AlertDestinationEntity[]> {
    try {
      return await this.destinations.find({ where: { enabled: true } });
    } catch (error) {
      this.logger.warn(
        `Alert destinations unreadable, delivering to the built-in ones only: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /** The owner when there is one; every administrator when nobody owns it. */
  private async ring(
    kind: AlertDeliveryKind,
    event: AlertEventEntity,
    ownerUserId: string | null,
  ): Promise<void> {
    try {
      const gateway = this.moduleRef?.get(UserEventsGateway, {
        strict: false,
      });
      if (!gateway) return;
      const recipients = ownerUserId
        ? [ownerUserId]
        : (
            await this.users.find({
              where: { isAdmin: true },
              select: { id: true },
            })
          ).map((u) => u.id);
      for (const userId of recipients) {
        gateway.emitAlert(userId, {
          id: event.id,
          kind,
          alertname: event.alertname,
          severity: event.severity,
          summary: event.annotations?.summary ?? event.alertname,
          applicationId: event.applicationId ?? null,
          applicationSlug: event.applicationSlug ?? null,
          startsAt: event.startsAt.toISOString(),
        });
      }
    } catch (error) {
      this.logger.warn(
        `Bell for ${event.alertname} not rung: ${(error as Error).message}`,
      );
    }
  }

  private async email(
    destination: AlertDestinationEntity,
    kind: AlertDeliveryKind,
    event: AlertEventEntity,
  ): Promise<AlertDeliveryOutcome> {
    const result = await this.mail.sendTo(kind, event, [
      destination.target ?? '',
    ]);
    return result.sent
      ? { ok: true, status: 'sent', error: null }
      : { ok: false, status: 'failed', error: result.error ?? 'not sent' };
  }

  private async post(
    destination: AlertDestinationEntity,
    kind: AlertDeliveryKind,
    event: AlertEventEntity,
  ): Promise<AlertDeliveryOutcome> {
    const url = destination.target ?? '';
    const policy = egressPolicyFromEnv();
    if (!url.startsWith('https://') && !this.plainHttpAllowed(url, policy)) {
      return {
        ok: false,
        status: 'failed',
        error:
          'Only https is allowed, or http to a host named in FLUI_EGRESS_ALLOWED_HOSTS',
      };
    }

    const body = JSON.stringify(this.payload(kind, event));
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = destination.secretEncrypted
      ? this.encryption.decrypt(destination.secretEncrypted)
      : '';
    const request = {
      method: 'POST' as const,
      url,
      data: body,
      timeout: WEBHOOK_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Flui-Alerts',
        'X-Flui-Timestamp': String(timestamp),
        'X-Flui-Delivery': randomUUID(),
        'X-Flui-Signature': signAlertWebhook(secret, timestamp, body),
      },
    };

    const response = await guardedRequest(request, policy);
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: String(response.status),
      error: ok ? null : `HTTP ${response.status}`,
    };
  }

  private payload(kind: AlertDeliveryKind, event: AlertEventEntity) {
    const endsAt = kind === 'resolved' ? event.endsAt : null;
    const installation =
      this.config.get<string>('FRONTEND_URL') ??
      this.config.get<string>('DASHBOARD_URL') ??
      null;
    return {
      alert: event.alertname,
      severity: event.severity,
      state: kind === 'resolved' ? 'resolved' : 'firing',
      summary: event.annotations?.summary ?? event.alertname,
      description: event.annotations?.description ?? null,
      application: event.applicationSlug ?? null,
      node: event.nodeInstance ?? null,
      startsAt: event.startsAt.toISOString(),
      ...(endsAt ? { endsAt: endsAt.toISOString() } : {}),
      installation,
      url: alertDashboardLink(event, installation),
    };
  }

  private plainHttpAllowed(url: string, policy: EgressPolicy): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'http:' && isAllowedHost(parsed.hostname, policy)
      );
    } catch {
      return false;
    }
  }
}
