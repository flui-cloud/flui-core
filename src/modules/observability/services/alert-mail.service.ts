import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MailSendService } from '../../mail/services/mail-send.service';
import { UserEntity } from '../../auth/entities/user.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { AlertEventEntity } from '../entities/alert-event.entity';
import { AlertMailAudience, renderAlertMail } from './alert-mail.template';

/**
 * Severities that are worth an email.
 *
 * Everything reaches the dashboard bell; only this reaches somebody who is not
 * looking at the dashboard. A warning that arrives at three in the morning
 * teaches people to filter the sender, which costs the critical one its
 * audience — so the gate is deliberately narrow and lives in one place.
 */
const EMAILED_SEVERITIES = new Set(['critical']);

export interface AlertMailSubject {
  /** The owner of the application the alert is about, when it has one. */
  ownerUserId?: string | null;
  /**
   * The installation opted administrators into warnings about what nobody
   * owns. An application's warnings still reach nobody's inbox.
   */
  adminWarnings?: boolean;
}

export interface AlertMailOutcome {
  sent: boolean;
  error?: string;
}

/**
 * Sends an alert to somebody who is not watching the screen.
 *
 * Two things decide the recipient, and they are different questions. An alert
 * about an application goes to whoever owns it. An alert about a node, a disk
 * or a cluster owns nothing and belongs to whoever runs the instance.
 *
 * Gated on `MAIL_FROM`, the same switch every other product email is gated on:
 * unset means email is not set up here, and guessing a sender on a domain the
 * provider has not verified is how an instance starts failing deliveries it
 * never sees.
 */
@Injectable()
export class AlertMailService {
  private readonly logger = new Logger(AlertMailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sender: MailSendService,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  configured(): boolean {
    return Boolean(this.config.get<string>('MAIL_FROM'));
  }

  /**
   * One transition, delivered. Never throws: an alert that cannot be emailed is
   * still an alert, and a failing mail provider must not take down the route
   * Alertmanager is calling.
   */
  async deliver(
    kind: 'fired' | 'resolved',
    event: AlertEventEntity,
    subject: AlertMailSubject = {},
  ): Promise<boolean> {
    if (!this.configured()) return false;
    if (!this.emailed(event, subject)) return false;

    const { to, audience } = await this.recipients(subject.ownerUserId ?? null);
    if (to.length === 0) {
      this.logger.warn(
        `No recipient for ${event.alertname}: nobody owns it and no administrator has an address`,
      );
      return false;
    }

    const outcome = await this.sendTo(kind, event, to, audience);
    if (outcome.error) {
      this.logger.warn(`Could not email ${event.alertname}: ${outcome.error}`);
    }
    return outcome.sent;
  }

  /**
   * The same message to addresses somebody chose, with no severity gate of
   * its own: whoever added the address already said what it wants to hear.
   */
  async sendTo(
    kind: 'fired' | 'resolved',
    event: AlertEventEntity,
    to: string[],
    audience: AlertMailAudience = 'destination',
  ): Promise<AlertMailOutcome> {
    const from = this.config.get<string>('MAIL_FROM');
    if (!from) {
      return { sent: false, error: 'Email is not set up on this installation' };
    }
    try {
      const mail = renderAlertMail(kind, event, {
        dashboardUrl:
          this.config.get<string>('FRONTEND_URL') ??
          this.config.get<string>('DASHBOARD_URL') ??
          null,
        clusterName: await this.clusterName(event.clusterId),
        audience,
      });
      await this.sender.send({
        from: {
          email: from,
          name: this.config.get<string>('MAIL_FROM_NAME') ?? 'Flui',
        },
        to: to.map((email) => ({ email })),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        reference: `alert:${event.fingerprint}:${kind}`,
      });
      return { sent: true };
    } catch (error) {
      return {
        sent: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private emailed(event: AlertEventEntity, subject: AlertMailSubject): boolean {
    const severity = (event.severity ?? '').toLowerCase();
    if (EMAILED_SEVERITIES.has(severity)) return true;
    return (
      severity === 'warning' &&
      Boolean(subject.adminWarnings) &&
      !subject.ownerUserId
    );
  }

  /**
   * Who hears about it. An owner when the alert has one, the instance's
   * administrators when it does not — a node going down is nobody's application
   * and everybody's problem.
   */
  private async recipients(
    ownerUserId: string | null,
  ): Promise<{ to: string[]; audience: AlertMailAudience }> {
    if (ownerUserId) {
      const owner = await this.users.findOne({
        where: { id: ownerUserId },
        select: { email: true },
      });
      if (owner?.email) return { to: [owner.email], audience: 'owner' };
    }

    const admins = await this.users.find({
      where: { isAdmin: true },
      select: { email: true },
    });
    return {
      to: admins.map((a) => a.email).filter((e): e is string => !!e),
      audience: 'admin',
    };
  }

  /** A name to read instead of an id; a lookup that fails costs only the row. */
  private async clusterName(
    clusterId: string | null | undefined,
  ): Promise<string | null> {
    if (!clusterId) return null;
    try {
      const cluster = await this.clusters.findOne({
        where: { id: clusterId },
        select: { id: true, name: true },
      });
      return cluster?.name ?? null;
    } catch {
      return null;
    }
  }
}
