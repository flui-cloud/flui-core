import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import axios from 'axios';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { CronExpressionParser } from 'cron-parser';
import { guardedRequest } from '../../../common/net/egress-guard';
import { RELEASE } from '../../../config/release.config';

const MIN_FRESHNESS_MS = 45 * 60 * 1000;
const FRESHNESS_SLACK_MS = 15 * 60 * 1000;

/**
 * Whether the last platform backup keeps the heartbeat going — when it does not,
 * the operator's absence evaluator alarms on BOTH master death and a
 * silently-failing backup.
 *
 * Judged against the schedule itself, not against a window: the backup is fresh
 * when it is no older than the last run the schedule asked for, once that run
 * has had 15 minutes to finish. A window derived from the gap between two runs
 * is wrong for any schedule whose gaps differ (weekdays only, twice a day). A
 * success in the last 45 minutes is always fresh, and with no readable schedule
 * that is the whole rule.
 */
export function isPlatformBackupFresh(
  lastSuccessAt: Date | null | undefined,
  cronSchedule: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastSuccessAt) return false;
  const last = new Date(lastSuccessAt).getTime();
  if (now.getTime() - last <= MIN_FRESHNESS_MS) return true;
  if (!cronSchedule) return false;
  try {
    const due = CronExpressionParser.parse(cronSchedule, {
      currentDate: new Date(now.getTime() - FRESHNESS_SLACK_MS),
      tz: 'UTC',
    })
      .prev()
      .getTime();
    return last >= due;
  } catch {
    return false;
  }
}

/**
 * Dead-man's switch (MVP-4, §7): the master POSTs a heartbeat to an operator-
 * configured external target every 5 min — BUT only while its last platform
 * backup is fresh. The absence evaluator (healthchecks.io / ntfy / self-hosted
 * elsewhere) lives OUTSIDE the master's failure domain and alarms on missed
 * beats. Flui only emits; it never evaluates its own liveness.
 */
@Injectable()
export class MasterHeartbeatScheduler {
  private readonly logger = new Logger(MasterHeartbeatScheduler.name);

  constructor(
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepo: Repository<BackupPolicyEntity>,
    @InjectRepository(BackupJobEntity)
    private readonly jobRepo: Repository<BackupJobEntity>,
  ) {}

  @Cron(process.env.MASTER_HEARTBEAT_CRON || CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    try {
      const policies = await this.policyRepo.find({
        where: { engineClass: BackupEngineClass.PLATFORM },
      });
      const url = this.heartbeatUrl(policies);
      if (!url) return; // no platform heartbeat configured — nothing to do

      // A paused or degraded policy is one the scheduler no longer runs: its
      // schedule promises nothing, so it cannot vouch for the backup.
      const running = policies.filter(
        (p) => p.enabled && p.status === BackupPolicyStatus.ACTIVE,
      );
      const last = await this.lastSuccessfulPlatformBackup(running);
      const lastAt = last?.finishedAt ?? null;
      const now = new Date();
      const fresh = running.some((p) =>
        isPlatformBackupFresh(lastAt, p.cronSchedule, now),
      );

      if (!fresh) {
        const lastLabel = lastAt
          ? `at ${new Date(lastAt).toISOString()}`
          : 'never';
        this.logger.warn(
          `[master-heartbeat] WITHHELD — last platform backup ${lastLabel} is stale; ` +
            `letting the external watchdog alarm.`,
        );
        return;
      }

      // Guarded: the URL is operator-configured and this runs from inside the
      // cluster every five minutes, which is a scheduled read primitive against
      // the private network if nothing judges the address.
      await guardedRequest({
        method: 'POST',
        url,
        data: {
          ts: new Date().toISOString(),
          version: RELEASE.version,
          lastPlatformBackupAt: lastAt,
          lastPlatformBackupStatus: 'ok',
        },
        timeout: 5000,
      });
    } catch (err: any) {
      // A heartbeat failure must never crash the cron; the watchdog will notice the gap.
      this.logger.warn(
        `[master-heartbeat] emit failed: ${err?.message ?? String(err)}`,
      );
    }
  }

  private heartbeatUrl(policies: BackupPolicyEntity[]): string | null {
    for (const p of policies) {
      const url = p.metadata?.platform?.heartbeat?.url as string | undefined;
      if (url) return url;
    }
    return null;
  }

  private async lastSuccessfulPlatformBackup(
    policies: BackupPolicyEntity[],
  ): Promise<BackupJobEntity | null> {
    const ids = policies.map((p) => p.id);
    if (ids.length === 0) return null;
    return this.jobRepo.findOne({
      where: { policyId: In(ids), status: BackupJobStatus.COMPLETED },
      order: { finishedAt: 'DESC' },
    });
  }
}
