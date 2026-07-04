import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import axios from 'axios';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupJobStatus } from '../enums/backup-job.enum';

/** A backup older than this makes the heartbeat go silent — the operator's absence
 * evaluator then alarms on BOTH master death and a silently-failing backup. */
const BACKUP_FRESHNESS_MS = 45 * 60 * 1000;

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

      const last = await this.lastSuccessfulPlatformBackup(policies);
      const lastAt = last?.finishedAt ?? null;
      const fresh =
        !!lastAt &&
        Date.now() - new Date(lastAt).getTime() <= BACKUP_FRESHNESS_MS;

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

      await axios.post(
        url,
        {
          ts: new Date().toISOString(),
          lastPlatformBackupAt: lastAt,
          lastPlatformBackupStatus: 'ok',
        },
        { timeout: 5000 },
      );
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
