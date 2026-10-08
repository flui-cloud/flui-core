import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { AlertMailService } from '../../observability/services/alert-mail.service';
import { SandboxWaitlistEntity } from '../entities/sandbox-waitlist.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

/**
 * Tells the administrators when people are waiting for a demo space: the one
 * refusal worth acting on, by adding a node or raising SANDBOX_MAX_SLOTS. Said
 * once when the line forms and once when it clears.
 */
@Injectable()
export class SandboxWaitlistAlertService {
  static readonly ALERTNAME = 'FluiSandboxPeopleWaiting';
  private static readonly FINGERPRINT = 'sandbox-waitlist';
  private readonly logger = new Logger(SandboxWaitlistAlertService.name);

  constructor(
    @InjectRepository(SandboxWaitlistEntity)
    private readonly waitlist: Repository<SandboxWaitlistEntity>,
    private readonly alerts: AlertEventsService,
    private readonly mail: AlertMailService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.check(new Date());
    } catch (error) {
      this.logger.warn(
        `Could not read the waiting list: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async check(now: Date): Promise<void> {
    const waiting = await this.waitlist.count({
      where: { offeredAt: IsNull() },
    });
    const firing = waiting > 0;
    const since = (
      await this.alerts.openEpisodes(SandboxWaitlistAlertService.FINGERPRINT)
    ).get(SandboxWaitlistAlertService.FINGERPRINT);
    if (!firing && !since) return;

    const transitions = await this.alerts.record([
      {
        fingerprint: SandboxWaitlistAlertService.FINGERPRINT,
        status: firing ? 'firing' : 'resolved',
        startsAt: since ?? now,
        endsAt: firing ? null : now,
        alertname: SandboxWaitlistAlertService.ALERTNAME,
        severity: 'warning',
        fluiKind: 'sandbox',
        labels: {},
        annotations: {
          summary: firing
            ? `${peopleWaiting(waiting)} waiting for a demo space`
            : 'Nobody is waiting for a demo space any more',
          description:
            'Every space is in use. Adding a worker node to the demo cluster, or raising SANDBOX_MAX_SLOTS, lets them in; they are mailed when a space is theirs.',
        },
      },
    ]);
    for (const { kind, event } of transitions) {
      await this.mail.deliver(kind, event, { adminWarnings: true });
    }
  }
}

function peopleWaiting(count: number): string {
  return count === 1 ? '1 person is' : `${count} people are`;
}
