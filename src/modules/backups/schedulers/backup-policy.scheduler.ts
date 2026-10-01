import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository, IsNull, Not } from 'typeorm';
import { CronExpressionParser } from 'cron-parser';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import { BackupJobsService } from '../services/backup-jobs.service';
import { BackupJobTriggerType } from '../enums/backup-job.enum';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  CLUSTER_GONE_REASON,
  PolicyClusterVerdict,
  policyClusterVerdict,
} from '../utils/policy-cluster.util';

@Injectable()
export class BackupPolicyScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupPolicyScheduler.name);

  constructor(
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepo: Repository<BackupPolicyEntity>,
    private readonly jobsService: BackupJobsService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
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
    const clusters = await this.clustersOf(due);

    for (const policy of due) {
      try {
        const verdict = this.verdictFor(policy, clusters);
        if (verdict === 'retire') {
          await this.retire(policy, now);
          continue;
        }
        if (verdict === 'skip') {
          await this.policyRepo.update(policy.id, {
            nextRunAt: this.computeNextRun(policy.cronSchedule, now),
          });
          this.logger.warn(
            `[backup-scheduler] skipped policy=${policy.id}: cluster ${policy.clusterId} is lost`,
          );
          continue;
        }
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

        await this.jobsService.createOnDemand(
          policy.userId,
          { policyId: policy.id },
          BackupJobTriggerType.SCHEDULED,
        );
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
    void this.retireGoneClusterPolicies().catch((err: Error) =>
      this.logger.error(
        `[backup-scheduler] retiring policies of deleted clusters failed: ${err.message}`,
      ),
    );
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

  /** Retires active policies whose cluster is already gone, at boot. */
  async retireGoneClusterPolicies(now = new Date()): Promise<number> {
    const active = await this.policyRepo.find({
      where: { enabled: true, status: BackupPolicyStatus.ACTIVE },
    });
    const clusters = await this.clustersOf(active);
    let retired = 0;
    for (const policy of active) {
      if (this.verdictFor(policy, clusters) !== 'retire') continue;
      await this.retire(policy, now);
      retired++;
    }
    return retired;
  }

  /**
   * Paused rather than deleted: its backups stay restorable, and a person can
   * still see why it stopped. Nothing runs against a cluster that is gone.
   */
  private async retire(policy: BackupPolicyEntity, now: Date): Promise<void> {
    policy.enabled = false;
    policy.status = BackupPolicyStatus.PAUSED;
    policy.nextRunAt = null as never;
    policy.metadata = {
      ...policy.metadata,
      pausedReason: CLUSTER_GONE_REASON,
      pausedAt: now.toISOString(),
    };
    await this.policyRepo.save(policy);
    this.logger.warn(
      `[backup-scheduler] paused policy=${policy.id}: cluster ${policy.clusterId} no longer exists`,
    );
  }

  private verdictFor(
    policy: BackupPolicyEntity,
    clusters: Map<string, ClusterEntity>,
  ): PolicyClusterVerdict {
    if (!policy.clusterId) return 'run';
    return policyClusterVerdict(clusters.get(policy.clusterId) ?? null);
  }

  private async clustersOf(
    policies: BackupPolicyEntity[],
  ): Promise<Map<string, ClusterEntity>> {
    const ids = [...new Set(policies.map((p) => p.clusterId).filter(Boolean))];
    if (ids.length === 0) return new Map();
    const found = await this.clusterRepo.find({
      where: { id: In(ids) },
      withDeleted: true,
    });
    return new Map(found.map((c) => [c.id, c]));
  }

  private computeNextRun(cron: string, from: Date): Date {
    const interval = CronExpressionParser.parse(cron, {
      currentDate: from,
      tz: 'UTC',
    });
    return interval.next().toDate();
  }
}
