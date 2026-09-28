import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupJobEntity } from '../entities/backup-job.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupJobStatus } from '../enums/backup-job.enum';
import { AlertEventEntity } from '../../observability/entities/alert-event.entity';

export const BACKUP_FAILED_ALERT = 'FluiBackupFailed';

function backupSummary(
  policyName: string,
  failed: boolean,
  errorMessage: string | null | undefined,
): string {
  if (!failed) return `Backup "${policyName}" succeeded again`;
  const reason = errorMessage ? `: ${errorMessage}` : '';
  return `Backup "${policyName}" failed${reason}`;
}

/**
 * Turns the outcome of a backup run into the same alert every other alert is:
 * recorded as an event, rung and emailed through the alert routing. One episode
 * per policy — the first failure opens it, further failures keep it open
 * without telling anyone again, and the next complete success closes it. A
 * success with nothing open records nothing.
 *
 * Never throws: an alert that cannot be raised must not turn a finished backup
 * into a failed one.
 */
@Injectable()
export class BackupAlertService {
  private readonly logger = new Logger(BackupAlertService.name);
  private readonly turns = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(BackupJobEntity)
    private readonly jobs: Repository<BackupJobEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policies: Repository<BackupPolicyEntity>,
    @InjectRepository(AlertEventEntity)
    private readonly events: Repository<AlertEventEntity>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async settled(jobId: string, status: BackupJobStatus): Promise<void> {
    const failed = status === BackupJobStatus.FAILED;
    // A partial run is neither news nor a recovery: some of what it protects
    // was not copied, so it can close nothing, and it is not a failure either.
    if (!failed && status !== BackupJobStatus.COMPLETED) return;

    try {
      const job = await this.jobs.findOne({ where: { id: jobId } });
      if (!job?.policyId) return;
      await this.inTurn(job.policyId, () => this.settle(job, failed));
    } catch (error) {
      this.logger.warn(
        `Backup alert for job ${jobId} not raised: ${(error as Error).message}`,
      );
    }
  }

  /**
   * One outcome per policy at a time. Two runs failing together would each
   * find no open episode and each open one; in turn, the second finds the
   * first's and keeps it open instead.
   */
  private async inTurn(key: string, work: () => Promise<void>): Promise<void> {
    const current = (this.turns.get(key) ?? Promise.resolve()).then(work);
    const tail = current.catch(() => undefined);
    this.turns.set(key, tail);
    try {
      await current;
    } finally {
      if (this.turns.get(key) === tail) this.turns.delete(key);
    }
  }

  private async settle(job: BackupJobEntity, failed: boolean): Promise<void> {
    const policy = await this.policies.findOne({
      where: { id: job.policyId as string },
    });
    if (!policy) return;

    const fingerprint = `backup:${policy.id}`;
    const open = await this.events.findOne({
      where: { fingerprint, status: 'firing' },
      order: { startsAt: 'DESC' },
    });
    if (!failed && !open) return;

    const platform = policy.engineClass === BackupEngineClass.PLATFORM;
    const incoming = {
      fingerprint,
      status: failed ? ('firing' as const) : ('resolved' as const),
      startsAt: open?.startsAt ?? new Date(),
      endsAt: failed ? null : new Date(),
      alertname: BACKUP_FAILED_ALERT,
      severity: platform ? 'critical' : 'warning',
      fluiKind: 'backup',
      clusterId: policy.clusterId ?? null,
      labels: {
        alertname: BACKUP_FAILED_ALERT,
        policy: policy.name,
        engine: policy.engineClass,
      },
      annotations: {
        summary: backupSummary(policy.name, failed, job.errorMessage),
      },
    };

    const { AlertEventsService } = await import(
      '../../observability/services/alert-events.service'
    );
    const { AlertRoutingService } = await import(
      '../../observability/services/alert-routing.service'
    );
    const recorder = this.moduleRef?.get(AlertEventsService, {
      strict: false,
    });
    const routing = this.moduleRef?.get(AlertRoutingService, {
      strict: false,
    });
    if (!recorder || !routing) return;

    const transitions = await recorder.record([incoming]);
    for (const { kind, event } of transitions) {
      void routing.deliver(kind, event, {
        ownerUserId: platform ? null : policy.userId,
      });
    }
  }
}
