import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MailSendService } from '../../mail/services/mail-send.service';
import { UserEntity } from '../../auth/entities/user.entity';
import { AlertEventEntity } from '../entities/alert-event.entity';

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
    const from = this.config.get<string>('MAIL_FROM');
    if (!from) return false;
    if (!EMAILED_SEVERITIES.has((event.severity ?? '').toLowerCase())) {
      return false;
    }

    const to = await this.recipients(subject.ownerUserId ?? null);
    if (to.length === 0) {
      this.logger.warn(
        `No recipient for ${event.alertname}: nobody owns it and no administrator has an address`,
      );
      return false;
    }

    try {
      await this.sender.send({
        from: {
          email: from,
          name: this.config.get<string>('MAIL_FROM_NAME') ?? 'Flui',
        },
        to: to.map((email) => ({ email })),
        subject: this.subjectLine(kind, event),
        text: this.body(kind, event),
        reference: `alert:${event.fingerprint}:${kind}`,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not email ${event.alertname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Who hears about it. An owner when the alert has one, the instance's
   * administrators when it does not — a node going down is nobody's application
   * and everybody's problem.
   */
  private async recipients(ownerUserId: string | null): Promise<string[]> {
    if (ownerUserId) {
      const owner = await this.users.findOne({
        where: { id: ownerUserId },
        select: { email: true },
      });
      if (owner?.email) return [owner.email];
    }

    const admins = await this.users.find({
      where: { isAdmin: true },
      select: { email: true },
    });
    return admins.map((a) => a.email).filter((e): e is string => !!e);
  }

  private subjectLine(
    kind: 'fired' | 'resolved',
    event: AlertEventEntity,
  ): string {
    const what = event.applicationSlug ?? event.nodeInstance ?? event.alertname;
    return kind === 'resolved'
      ? `Recovered: ${what}`
      : `${event.severity ?? 'alert'}: ${what}`;
  }

  /**
   * Plain text, and short. What happened, to what, since when, and where to
   * look — an alert email that needs reading twice has already failed the
   * person woken up by it.
   */
  private body(kind: 'fired' | 'resolved', event: AlertEventEntity): string {
    const summary =
      event.annotations?.summary ?? event.annotations?.description ?? '';
    const started = event.startsAt?.toISOString() ?? 'unknown';
    const lines = [
      kind === 'resolved' ? 'This has recovered.' : summary || event.alertname,
      '',
      `alert     ${event.alertname}`,
      `severity  ${event.severity ?? 'unknown'}`,
      `since     ${started}`,
    ];
    if (event.applicationSlug)
      lines.push(`application  ${event.applicationSlug}`);
    if (event.namespace) lines.push(`namespace    ${event.namespace}`);
    if (event.nodeInstance) lines.push(`node         ${event.nodeInstance}`);
    if (kind === 'resolved' && event.endsAt) {
      lines.push(`recovered    ${event.endsAt.toISOString()}`);
    }
    // What to do about it, when the rule knows. An alert that says a volume is
    // full and leaves the reader to go and find the command is the difference
    // between being notified and being told — and for the alerts that exist so
    // somebody can decide whether to spend money, the command *is* the message.
    const action = event.annotations?.action;
    if (kind === 'fired' && action) {
      lines.push('', 'To fix it:', `  ${action}`);
    }
    if (kind === 'fired') {
      lines.push('', 'You will get one more message when it recovers.');
    }
    return lines.join('\n');
  }
}
