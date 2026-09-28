import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { AuditEventEntity, AuditOutcome } from './entities/audit-event.entity';

export interface AuditEntry {
  userId?: string | null;
  email?: string | null;
  actorKind?: string | null;
  actorKeyId?: string | null;
  action: string;
  target?: Record<string, string> | null;
  status?: number | null;
  outcome: AuditOutcome;
  permission?: string | null;
  dataAccess?: boolean;
}

export interface AuditQuery {
  email?: string;
  since?: Date;
  until?: Date;
  dataAccess?: boolean;
  outcome?: AuditOutcome;
  limit: number;
}

const DEFAULT_RETENTION_DAYS = 365;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly events: Repository<AuditEventEntity>,
  ) {}

  /**
   * Never throws. A record that failed to write must not take down the request
   * it describes; the failure is logged instead.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.events.insert({
        userId: entry.userId ?? null,
        email: entry.email ?? null,
        actorKind: entry.actorKind ?? null,
        actorKeyId: entry.actorKeyId ?? null,
        action: entry.action,
        target: entry.target ?? null,
        status: entry.status ?? null,
        outcome: entry.outcome,
        permission: entry.permission ?? null,
        dataAccess: entry.dataAccess ?? false,
      });
    } catch (error) {
      this.logger.warn(
        `Could not record "${entry.action}" for ${entry.email ?? entry.userId ?? 'unknown'}: ${(error as Error).message}`,
      );
    }
  }

  list(query: AuditQuery): Promise<AuditEventEntity[]> {
    const qb = this.events
      .createQueryBuilder('e')
      .orderBy('e.at', 'DESC')
      .take(query.limit);
    if (query.email) qb.andWhere('e.email = :email', { email: query.email });
    if (query.since) qb.andWhere('e.at >= :since', { since: query.since });
    if (query.until) qb.andWhere('e.at < :until', { until: query.until });
    if (query.dataAccess !== undefined) {
      qb.andWhere('e.dataAccess = :dataAccess', {
        dataAccess: query.dataAccess,
      });
    }
    if (query.outcome) {
      qb.andWhere('e.outcome = :outcome', { outcome: query.outcome });
    }
    return qb.getMany();
  }

  @Cron(process.env.AUDIT_PRUNE_CRON || CronExpression.EVERY_DAY_AT_4AM)
  async prune(): Promise<void> {
    const days =
      Number.parseInt(process.env.AUDIT_RETENTION_DAYS ?? '', 10) ||
      DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const { affected } = await this.events.delete({ at: LessThan(cutoff) });
    if (affected) {
      this.logger.log(
        `Removed ${affected} audit records older than ${days} days`,
      );
    }
  }
}
