import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InferenceUsageEventEntity } from '../entities/inference-usage-event.entity';

export interface UsageRecord {
  userId: string | null;
  guest: boolean;
  model: string;
  endpoint: string;
  surface: string;
  promptTokens: number;
  completionTokens: number;
  estimated?: boolean;
}

export interface UsageByModel {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  estimated: number;
}

export interface UsageByPerson {
  userId: string | null;
  guest: boolean;
  calls: number;
  tokens: number;
  lastAt: Date;
}

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
        estimated: !!usage.estimated,
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
      .select('COALESCE(SUM(u."promptTokens" + u."completionTokens"), 0)', 'n')
      .where('u."userId" = :userId', { userId });
    if (since) qb.andWhere('u."createdAt" >= :since', { since });
    const row = await qb.getRawOne<{ n: string }>();
    return Number(row?.n ?? 0);
  }

  async byModel(since?: Date): Promise<UsageByModel[]> {
    const qb = this.events
      .createQueryBuilder('u')
      .select('u.model', 'model')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COALESCE(SUM(u."promptTokens"), 0)', 'prompt')
      .addSelect('COALESCE(SUM(u."completionTokens"), 0)', 'completion')
      .addSelect('COUNT(*) FILTER (WHERE u.estimated)', 'estimated')
      .groupBy('u.model')
      .orderBy('completion', 'DESC');
    if (since) qb.where('u."createdAt" >= :since', { since });
    const rows = await qb.getRawMany<{
      model: string;
      calls: string;
      prompt: string;
      completion: string;
      estimated: string;
    }>();
    return rows.map((r) => ({
      model: r.model,
      calls: Number(r.calls),
      promptTokens: Number(r.prompt),
      completionTokens: Number(r.completion),
      estimated: Number(r.estimated),
    }));
  }

  /** Who is spending, heaviest first. Guests and members in one list. */
  async byPerson(since?: Date, limit = 20): Promise<UsageByPerson[]> {
    const qb = this.events
      .createQueryBuilder('u')
      .select('u."userId"', 'userId')
      .addSelect('BOOL_OR(u.guest)', 'guest')
      .addSelect('COUNT(*)', 'calls')
      .addSelect(
        'COALESCE(SUM(u."promptTokens" + u."completionTokens"), 0)',
        'tokens',
      )
      .addSelect('MAX(u."createdAt")', 'lastAt')
      .groupBy('u."userId"')
      .orderBy('tokens', 'DESC')
      .limit(limit);
    if (since) qb.where('u."createdAt" >= :since', { since });
    const rows = await qb.getRawMany<{
      userId: string | null;
      guest: boolean;
      calls: string;
      tokens: string;
      lastAt: Date;
    }>();
    return rows.map((r) => ({
      userId: r.userId,
      guest: !!r.guest,
      calls: Number(r.calls),
      tokens: Number(r.tokens),
      lastAt: r.lastAt,
    }));
  }
}

/** The host alone: two connections to the same provider read as one source. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.slice(0, 255);
  } catch {
    return url.slice(0, 255);
  }
}
