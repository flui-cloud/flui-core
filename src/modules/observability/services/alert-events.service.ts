import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import {
  AlertEventEntity,
  AlertEventStatus,
} from '../entities/alert-event.entity';

/** One alert from an Alertmanager batch, with its subject already resolved. */
export interface IncomingAlert {
  fingerprint: string;
  status: AlertEventStatus;
  startsAt: Date;
  endsAt?: Date | null;
  alertname: string;
  severity: string;
  fluiKind?: string | null;
  clusterId?: string | null;
  applicationId?: string | null;
  applicationSlug?: string | null;
  namespace?: string | null;
  nodeInstance?: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** What changed, for whoever delivers notifications. */
export type AlertTransitionKind = 'fired' | 'resolved';

export interface AlertTransition {
  kind: AlertTransitionKind;
  event: AlertEventEntity;
}

/**
 * A firing row is refreshed on every repeat, so one that has gone quiet for longer
 * than the repeat interval is a row whose `resolved` notification never arrived.
 * 6h against Alertmanager's 4h `repeat_interval` leaves room for group jitter and
 * retries without leaving a false alarm on screen for a working day.
 */
const STALE_AFTER_HOURS = 6;
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Persists what Alertmanager reports and reports back what changed.
 *
 * Deliberately not a notifier: it returns transitions and lets the caller deliver.
 * Notifying on a transition rather than on every message is what keeps a 4h repeat
 * from paging someone about an incident they already know about.
 */
@Injectable()
export class AlertEventsService {
  private readonly logger = new Logger(AlertEventsService.name);

  constructor(
    @InjectRepository(AlertEventEntity)
    private readonly events: Repository<AlertEventEntity>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Records a batch and returns only the genuine transitions — a repeat of something
   * already firing changes the row but is nobody's news.
   */
  async record(alerts: IncomingAlert[]): Promise<AlertTransition[]> {
    const transitions: AlertTransition[] = [];

    for (const alert of alerts) {
      try {
        const transition = await this.recordOne(alert);
        if (transition) transitions.push(transition);
      } catch (error) {
        // One malformed alert must not cost us the rest of the batch: Alertmanager
        // retries the whole POST, and a 500 here would replay the good ones too.
        this.logger.error(
          `Failed to record alert ${alert.alertname} (${alert.fingerprint}): ${
            (error as Error)?.message ?? error
          }`,
        );
      }
    }

    return transitions;
  }

  private async recordOne(
    alert: IncomingAlert,
  ): Promise<AlertTransition | null> {
    const existing = await this.events.findOne({
      where: { fingerprint: alert.fingerprint, startsAt: alert.startsAt },
    });

    if (!existing) {
      const created = await this.insert(alert);
      // A resolve for an episode we never saw fire is recorded, not announced —
      // announcing it would mean "recovered" for something nobody was told about.
      return created && alert.status === 'firing'
        ? { kind: 'fired', event: created }
        : null;
    }

    const wasFiring = existing.status === 'firing';
    existing.status = alert.status;
    existing.lastSeenAt = new Date();
    existing.annotations = alert.annotations;
    existing.labels = alert.labels;
    if (alert.status === 'resolved') {
      // endsAt comes from the payload, not from now(): it is when the condition
      // cleared, which is not when the notification reached us.
      existing.endsAt = alert.endsAt ?? new Date();
      existing.resolvedBy = 'alertmanager';
    }
    const saved = await this.events.save(existing);

    return wasFiring && alert.status === 'resolved'
      ? { kind: 'resolved', event: saved }
      : null;
  }

  private async insert(alert: IncomingAlert): Promise<AlertEventEntity | null> {
    const entity = this.events.create({
      fingerprint: alert.fingerprint,
      startsAt: alert.startsAt,
      endsAt: alert.status === 'resolved' ? (alert.endsAt ?? new Date()) : null,
      lastSeenAt: new Date(),
      status: alert.status,
      resolvedBy: alert.status === 'resolved' ? 'alertmanager' : null,
      alertname: alert.alertname,
      severity: alert.severity,
      fluiKind: alert.fluiKind ?? null,
      clusterId: alert.clusterId ?? null,
      applicationId: alert.applicationId ?? null,
      applicationSlug: alert.applicationSlug ?? null,
      namespace: alert.namespace ?? null,
      nodeInstance: alert.nodeInstance ?? null,
      labels: alert.labels,
      annotations: alert.annotations,
    });

    try {
      return await this.events.save(entity);
    } catch (error) {
      // Alertmanager retries can race a group flush. The unique constraint is what
      // makes that safe; losing the race means the row exists, which is the goal.
      if (this.isUniqueViolation(error)) {
        this.logger.debug(
          `Concurrent insert for ${alert.fingerprint}; row already exists`,
        );
        return null;
      }
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string })?.code === '23505';
  }

  async listByApplication(
    applicationId: string,
    options: { status?: AlertEventStatus; limit?: number } = {},
  ): Promise<AlertEventEntity[]> {
    return this.events.find({
      where: {
        applicationId,
        ...(options.status ? { status: options.status } : {}),
      },
      order: { startsAt: 'DESC' },
      take: options.limit ?? 50,
    });
  }

  async listByApplications(
    applicationIds: string[],
    options: { status?: AlertEventStatus; limit?: number } = {},
  ): Promise<AlertEventEntity[]> {
    if (applicationIds.length === 0) return [];
    return this.events.find({
      where: {
        applicationId: In(applicationIds),
        ...(options.status ? { status: options.status } : {}),
      },
      order: { startsAt: 'DESC' },
      take: options.limit ?? 100,
    });
  }

  /**
   * Infrastructure alerts (nodes, and anything whose subject could not be resolved to
   * an application) are admin-only: their annotations carry hostnames and service ids.
   */
  async listInfrastructure(
    options: { status?: AlertEventStatus; limit?: number } = {},
  ): Promise<AlertEventEntity[]> {
    const rows = await this.events.find({
      where: options.status ? { status: options.status } : {},
      order: { startsAt: 'DESC' },
      take: (options.limit ?? 100) * 2,
    });
    return rows
      .filter((row) => !row.applicationId)
      .slice(0, options.limit ?? 100);
  }

  /**
   * Closes rows whose `resolved` notification never arrived — the API being down or
   * redeploying at the wrong moment is enough, and Alertmanager sends `send_resolved`
   * once. Left alone they read as a permanent false alarm.
   */
  async resolveStale(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3600 * 1000);
    const stale = await this.events.find({
      where: { status: 'firing', lastSeenAt: LessThan(cutoff) },
    });
    if (stale.length === 0) return 0;

    for (const row of stale) {
      row.status = 'resolved';
      row.resolvedBy = 'timeout';
      row.endsAt = row.lastSeenAt;
    }
    await this.events.save(stale);
    this.logger.warn(
      `Closed ${stale.length} alert(s) that stopped repeating without resolving`,
    );
    return stale.length;
  }

  /**
   * Operational history, not an audit log. Firing rows are never deleted regardless
   * of age — an old row that is still firing is the incident, not the archive.
   */
  async purgeOld(): Promise<number> {
    const days = Number(
      this.config.get<string>('ALERT_EVENT_RETENTION_DAYS') ??
        DEFAULT_RETENTION_DAYS,
    );
    const retention =
      Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - retention * 86400 * 1000);

    const result = await this.events.delete({
      status: 'resolved',
      startsAt: LessThan(cutoff),
    });
    const deleted = result.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(
        `Purged ${deleted} alert(s) resolved more than ${retention} days ago`,
      );
    }
    return deleted;
  }
}
