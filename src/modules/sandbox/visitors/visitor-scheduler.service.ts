import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { LOCAL_JOB } from '../../common/leadership/scheduler-leadership.service';
import { withAdvisoryLock } from '../../common/leadership/advisory-lock';
import { describeError } from '../../shared/utils/error.util';
import { VisitorPoolService } from './visitor-pool.service';
import { VisitorSweepService } from './visitor-sweep.service';
import { VisitorLinkService } from './visitor-link.service';
import { VisitorLoginClientService } from './visitor-login-client.service';
import { VisitorRefusalsService } from './visitor-refusals.service';
import { serviceConnection } from './provider-connection';
import { VISITOR_CONFIG, VisitorConfig } from './visitor.config';

/**
 * The visitors' clocks. Local jobs held by an advisory lock rather than by
 * scheduler leadership: whichever copy of the API carries the entrance keeps
 * its pool, even beside an older copy that holds the leadership.
 */
@Injectable()
export class VisitorSchedulerService {
  private readonly logger = new Logger(VisitorSchedulerService.name);
  private failing = false;

  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    private readonly dataSource: DataSource,
    private readonly pool: VisitorPoolService,
    private readonly sweep: VisitorSweepService,
    private readonly links: VisitorLinkService,
    private readonly loginClient: VisitorLoginClientService,
    private readonly refusals: VisitorRefusalsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: `${LOCAL_JOB}sandbox-visitor-pool`,
  })
  async keepPool(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await withAdvisoryLock(
        this.dataSource,
        'sandbox-visitor-pool',
        async () => {
          await this.pool.recycle();
          await this.pool.refill();
        },
      );
      if (this.failing)
        this.logger.log('Visitors are made ahead of time again');
      this.failing = false;
    } catch (error) {
      if (!this.failing) {
        this.logger.warn(
          `Could not make visitors ahead of time: ${describeError(error)}`,
        );
      }
      this.failing = true;
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES, {
    name: `${LOCAL_JOB}sandbox-visitor-sweep`,
  })
  async sweepVisitors(): Promise<void> {
    if (!this.config.sandboxEnabled) return;
    try {
      await withAdvisoryLock(
        this.dataSource,
        'sandbox-visitor-sweep',
        async () => {
          await this.sweep.sweep();
          await this.links.purgeExpired();
          await this.refusals.purge();
        },
      );
    } catch (error) {
      this.logger.warn(`Visitor sweep failed: ${describeError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR, {
    name: `${LOCAL_JOB}sandbox-visitor-login-client`,
  })
  async renewLoginClient(): Promise<void> {
    if (!this.config.enabled) return;
    const conn = serviceConnection();
    if (!conn) return;
    try {
      if (await this.loginClient.renewIfDue(conn)) {
        this.logger.log('The visitors’ login credential was renewed');
      }
    } catch (error) {
      this.logger.warn(
        `The visitors’ login credential was not renewed: ${describeError(error)}`,
      );
    }
  }
}
