import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { describeError } from '../../shared/utils/error.util';
import { SandboxVisitorRefusalEntity } from '../entities/sandbox-visitor-refusal.entity';

export const VISITOR_REFUSAL = {
  CLOSED: 'closed',
  LIMIT_IP: 'limit-ip',
  LIMIT_CLI: 'limit-cli',
  LIMIT_GLOBAL: 'limit-global',
  LIMIT_DAY: 'limit-day',
  CHALLENGE: 'challenge',
  INVALID: 'invalid',
  NO_ADMISSION: 'no-admission',
  ERROR: 'error',
} as const;

export type VisitorRefusalReason =
  (typeof VISITOR_REFUSAL)[keyof typeof VISITOR_REFUSAL];

const KEEP_MS = 7 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;

/** How many visitors were turned away, and why: one counter per hour and reason. */
@Injectable()
export class VisitorRefusalsService {
  private readonly logger = new Logger(VisitorRefusalsService.name);

  constructor(
    @InjectRepository(SandboxVisitorRefusalEntity)
    private readonly refusals: Repository<SandboxVisitorRefusalEntity>,
  ) {}

  /** Never throws: a lost count is not a reason to answer the visitor differently. */
  async note(reason: VisitorRefusalReason, now = new Date()): Promise<void> {
    const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    try {
      await this.refusals.query(
        `INSERT INTO "sandbox_visitor_refusals" ("hour", "reason", "count") VALUES ($1, $2, 1)
         ON CONFLICT ("hour", "reason") DO UPDATE SET "count" = "sandbox_visitor_refusals"."count" + 1`,
        [hour, reason],
      );
    } catch (error) {
      this.logger.warn(
        `Could not count a refused visitor: ${describeError(error)}`,
      );
    }
  }

  async since(from: Date): Promise<Array<{ reason: string; count: number }>> {
    const rows = await this.refusals.find({
      where: { hour: MoreThanOrEqual(from) },
    });
    const totals = new Map<string, number>();
    for (const row of rows) {
      totals.set(row.reason, (totals.get(row.reason) ?? 0) + row.count);
    }
    return [...totals.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  }

  async purge(now = new Date()): Promise<number> {
    const result = await this.refusals.delete({
      hour: LessThan(new Date(now.getTime() - KEEP_MS)),
    });
    return result.affected ?? 0;
  }
}
