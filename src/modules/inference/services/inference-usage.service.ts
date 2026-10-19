import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { InferenceUsageEventEntity } from '../entities/inference-usage-event.entity';
import { SandboxVisitorEntity } from '../../sandbox/entities/sandbox-visitor.entity';

export interface UsageRecord {
  userId: string | null;
  guest: boolean;
  model: string;
  endpoint: string;
  surface: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  estimated?: boolean;
  ipHash?: string | null;
}

export const IP_HASH_RETENTION_MS = 48 * 3_600_000;

export interface UsageByModel {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  estimated: number;
}

export type UsageKind = 'visitor' | 'guest' | 'person' | 'platform';

export interface UsageByPerson {
  userId: string | null;
  guest: boolean;
  kind: UsageKind;
  calls: number;
  tokens: number;
  lastAt: Date;
}

export interface UsageByKind {
  kind: UsageKind;
  people: number;
  calls: number;
  tokens: number;
}

/** Still a visitor, or one removed before it became an account: its spend stays a visitor's. */
const VISITOR_SQL = 'sv."userId" IS NOT NULL AND sv."upgradedAt" IS NULL';
const TOKENS_SQL = 'COALESCE(SUM(u."promptTokens" + u."completionTokens"), 0)';
const SINCE_SQL = 'u."createdAt" >= :since';
const KIND_SQL = `CASE WHEN u."userId" IS NULL THEN 'platform' WHEN ${VISITOR_SQL} THEN 'visitor' WHEN u.guest THEN 'guest' ELSE 'person' END`;

/**
 * What inference has cost, and who spent it.
 *
 * Recording never throws. A provider answered, the person has their reply, and
 * losing the accounting row is not a reason to turn that into an error on their
 * screen — it is a reason for a line in the log that an operator can find.
 */
@Injectable()
export class InferenceUsageService {
  private readonly logger = new Logger(InferenceUsageService.name);

  constructor(
    @InjectRepository(InferenceUsageEventEntity)
    private readonly events: Repository<InferenceUsageEventEntity>,
  ) {}

  async record(usage: UsageRecord): Promise<void> {
    try {
      await this.events.insert({
        userId: usage.userId,
        guest: usage.guest,
        model: usage.model.slice(0, 128),
        endpoint: hostOf(usage.endpoint),
        surface: usage.surface.slice(0, 64),
        promptTokens: Math.max(0, Math.round(usage.promptTokens)),
        completionTokens: Math.max(0, Math.round(usage.completionTokens)),
        cachedPromptTokens: Math.max(
          0,
          Math.min(
            Math.round(usage.cachedPromptTokens ?? 0),
            Math.round(usage.promptTokens),
          ),
        ),
        estimated: !!usage.estimated,
        ipHash: usage.ipHash ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Could not record inference usage: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Everything one person has spent. The number a budget is checked against. */
  async tokensFor(userId: string, since?: Date): Promise<number> {
    const qb = this.events
      .createQueryBuilder('u')
      .select(TOKENS_SQL, 'n')
      .where('u."userId" = :userId', { userId });
    if (since) qb.andWhere(SINCE_SQL, { since });
    const row = await qb.getRawOne<{ n: string }>();
    return Number(row?.n ?? 0);
  }

  /** Everything everyone has spent since a moment. The number spend alerts read. */
  async totalSince(since: Date): Promise<number> {
    const row = await this.events
      .createQueryBuilder('u')
      .select(TOKENS_SQL, 'n')
      .where(SINCE_SQL, { since })
      .getRawOne<{ n: string }>();
    return Number(row?.n ?? 0);
  }

  /** What every guest together has spent since a moment. The instance's daily cap reads it. */
  async guestTotalSince(since: Date): Promise<number> {
    const row = await this.events
      .createQueryBuilder('u')
      .select(TOKENS_SQL, 'n')
      .where('u.guest = true')
      .andWhere(SINCE_SQL, { since })
      .getRawOne<{ n: string }>();
    return Number(row?.n ?? 0);
  }

  /** What the guests behind one address have spent since a moment. */
  async tokensForAddress(ipHash: string, since: Date): Promise<number> {
    const row = await this.events
      .createQueryBuilder('u')
      .select(TOKENS_SQL, 'n')
      .where('u."ipHash" = :ipHash', { ipHash })
      .andWhere(SINCE_SQL, { since })
      .getRawOne<{ n: string }>();
    return Number(row?.n ?? 0);
  }

  async forgetAddresses(now = new Date()): Promise<number> {
    const result = await this.events.update(
      {
        ipHash: Not(IsNull()),
        createdAt: LessThan(new Date(now.getTime() - IP_HASH_RETENTION_MS)),
      },
      { ipHash: null },
    );
    return result.affected ?? 0;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async forgetAddressesTick(): Promise<void> {
    try {
      await this.forgetAddresses();
    } catch (error) {
      this.logger.warn(
        `Could not clear old guest address hashes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async byModel(since?: Date): Promise<UsageByModel[]> {
    const qb = this.events
      .createQueryBuilder('u')
      .select('u.model', 'model')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(u."promptTokens"), 0)', 'prompt')
      .addSelect('COALESCE(SUM(u."completionTokens"), 0)', 'completion')
      .addSelect('COALESCE(SUM(u."cachedPromptTokens"), 0)', 'cached')
      .addSelect('COUNT(*) FILTER (WHERE u.estimated)', 'estimated')
      .groupBy('u.model')
      .orderBy('completion', 'DESC');
    if (since) qb.where(SINCE_SQL, { since });
    const rows = await qb.getRawMany<{
      model: string;
      calls: string;
      prompt: string;
      completion: string;
      cached: string;
      estimated: string;
    }>();
    return rows.map((r) => ({
      model: r.model,
      calls: Number(r.calls),
      promptTokens: Number(r.prompt),
      completionTokens: Number(r.completion),
      cachedPromptTokens: Number(r.cached ?? 0),
      estimated: Number(r.estimated),
    }));
  }

  /** The spend of visitors, guests, people and the platform itself, each in one line. */
  async byKind(since?: Date): Promise<UsageByKind[]> {
    const qb = this.events
      .createQueryBuilder('u')
      .leftJoin(SandboxVisitorEntity, 'sv', 'sv."userId" = u."userId"')
      .select(KIND_SQL, 'kind')
      .addSelect('COUNT(DISTINCT u."userId")', 'people')
      .addSelect('COUNT(*)', 'calls')
      .addSelect(TOKENS_SQL, 'tokens')
      .groupBy('1')
      .orderBy('tokens', 'DESC');
    if (since) qb.where(SINCE_SQL, { since });
    const rows = await qb.getRawMany<{
      kind: UsageKind;
      people: string;
      calls: string;
      tokens: string;
    }>();
    return rows.map((r) => ({
      kind: r.kind,
      people: Number(r.people),
      calls: Number(r.calls),
      tokens: Number(r.tokens),
    }));
  }

  /** Who is spending, heaviest first. Visitors, guests and members in one list. */
  async byPerson(since?: Date, limit = 20): Promise<UsageByPerson[]> {
    const qb = this.events
      .createQueryBuilder('u')
      .select('u."userId"', 'userId')
      .leftJoin(SandboxVisitorEntity, 'sv', 'sv."userId" = u."userId"')
      .addSelect('BOOL_OR(u.guest)', 'guest')
      .addSelect(`BOOL_OR(${VISITOR_SQL})`, 'visitor')
      .addSelect('COUNT(*)', 'calls')
      .addSelect(TOKENS_SQL, 'tokens')
      .addSelect('MAX(u."createdAt")', 'lastAt')
      .groupBy('u."userId"')
      .orderBy('tokens', 'DESC')
      .limit(limit);
    if (since) qb.where(SINCE_SQL, { since });
    const rows = await qb.getRawMany<{
      userId: string | null;
      guest: boolean;
      visitor: boolean;
      calls: string;
      tokens: string;
      lastAt: Date;
    }>();
    return rows.map((r) => ({
      userId: r.userId,
      guest: !!r.guest,
      kind: kindOf(r),
      calls: Number(r.calls),
      tokens: Number(r.tokens),
      lastAt: r.lastAt,
    }));
  }
}

function kindOf(r: {
  userId: string | null;
  guest: boolean;
  visitor: boolean;
}): UsageKind {
  if (!r.userId) return 'platform';
  if (r.visitor) return 'visitor';
  return r.guest ? 'guest' : 'person';
}

/** The host alone: two connections to the same provider read as one source. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.slice(0, 255);
  } catch {
    return url.slice(0, 255);
  }
}
