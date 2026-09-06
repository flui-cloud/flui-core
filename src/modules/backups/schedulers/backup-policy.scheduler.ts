import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository, IsNull, Not } from 'typeorm';
import { CronExpressionParser } from 'cron-parser';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { BackupJobsService } from '../services/backup-jobs.service';

@Injectable()
export class BackupPolicyScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupPolicyScheduler.name);

  constructor(
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepo: Repository<BackupPolicyEntity>,
    private readonly jobsService: BackupJobsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const now = new Date();
    const due = await this.policyRepo.find({
      where: {
        enabled: true,
        status: BackupPolicyStatus.ACTIVE,
        cronSchedule: Not(IsNull()),
        nextRunAt: LessThanOrEqual(now),
      },
    });
    if (due.length === 0) return;

    for (const policy of due) {
      try {
        // Anti-double-fire: lastRunAt close enough to now → skip and recompute
        if (
          policy.lastRunAt &&
          now.getTime() - policy.lastRunAt.getTime() < 60_000
        ) {
          await this.policyRepo.update(policy.id, {
            nextRunAt: this.computeNextRun(policy.cronSchedule, now),
          });
          continue;
        }

        await this.jobsService.createOnDemand(policy.userId, {
          policyId: policy.id,
        });
        await this.policyRepo.update(policy.id, {
          lastRunAt: now,
          nextRunAt: this.computeNextRun(policy.cronSchedule, now),
        });
        this.logger.log(
          `[backup-scheduler] enqueued policy=${policy.id} cron=${policy.cronSchedule}`,
        );
      } catch (err: any) {
        this.logger.error(
          `[backup-scheduler] failed policy=${policy.id}: ${err?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Nothing else ever writes `nextRunAt`: `create` leaves it null and `tick`
   * only selects rows where it is already due, so a policy is born unable to
   * become due. Every scheduled backup on an installation waits forever, while
   * the policy reads enabled and active.
   *
   * This used to say it ran "on app boot via init() helper called from module".
   * There was no such helper and no caller.
   */
  onApplicationBootstrap(): void {
    void this.backfillNextRun().catch((err: Error) =>
      this.logger.error(
        `[backup-scheduler] backfill of nextRunAt failed: ${err.message}`,
      ),
    );
  }

  /** Computes `nextRunAt` for any policy that has a cron but no next run. */
  async backfillNextRun(): Promise<void> {
    const policies = await this.policyRepo.find({
      where: {
        enabled: true,
        cronSchedule: Not(IsNull()),
        nextRunAt: IsNull(),
      },
    });
    for (const p of policies) {
      try {
        await this.policyRepo.update(p.id, {
          nextRunAt: this.computeNextRun(p.cronSchedule, new Date()),
        });
      } catch (err: any) {
        this.logger.warn(
          `[backup-scheduler] backfill failed policy=${p.id}: ${err?.message}`,
        );
      }
    }
  }

  private computeNextRun(cron: string, from: Date): Date {
    const interval = CronExpressionParser.parse(cron, {
      currentDate: from,
      tz: 'UTC',
    });
    return interval.next().toDate();
  }
}
