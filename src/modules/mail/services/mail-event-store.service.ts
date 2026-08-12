import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { DeliveryEvent, DeliveryEventKind } from '@flui-cloud/mail';
import {
  MAIL_EVENT_RETENTION_DAYS,
  MailEventEntity,
  MailEventKind,
} from '../entities/mail-event.entity';

export interface MailEventQuery {
  from?: Date;
  to?: Date;
  kinds?: MailEventKind[];
  /** Envelope sender, exact. The axis the console groups by. */
  fromAddress?: string;
  /** Matches either side of the address, case-insensitively. */
  search?: string;
  limit?: number;
  offset?: number;
  /** Costs a second query. Off unless a caller actually shows the number. */
  withTotal?: boolean;
}

export interface MailEventPage {
  events: DeliveryEvent[];
  total: number;
}

const MAX_PAGE = 200;
/** Postgres caps a statement at 65535 parameters; ten columns leaves ample room. */
const INSERT_CHUNK = 500;

/**
 * Where delivery outcomes live between polls.
 *
 * The provider is the source of truth and stays that way — nothing here is
 * authoritative. It exists because asking the provider is not free: Scaleway
 * pages at a hundred emails a call and filters on *creation* date, so answering
 * "how did the last fortnight go" from the API means several thousand HTTP
 * round trips on every page load, and answering "and how did the fortnight
 * before that compare" means twice that. A table turns both into one query.
 */
@Injectable()
export class MailEventStoreService {
  private readonly logger = new Logger(MailEventStoreService.name);

  constructor(
    @InjectRepository(MailEventEntity)
    private readonly repo: Repository<MailEventEntity>,
  ) {}

  /**
   * Fold a poll into the table.
   *
   * `ON CONFLICT DO UPDATE ... WHERE excluded.at >= at` is the whole design in
   * one clause. A poll re-reads mail it has already seen, on purpose, so that a
   * refusal arriving hours after the send is not missed — which means the same
   * row is written many times and must not regress. Without the guard a reply
   * that arrives out of order would overwrite a newer verdict with an older one,
   * and the message would sit there reported as delivered after it bounced.
   */
  async record(events: readonly DeliveryEvent[]): Promise<number> {
    const rows = events
      .map(toRow)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return 0;

    let written = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      written += await this.insertChunk(rows.slice(i, i + INSERT_CHUNK));
    }
    return written;
  }

  private async insertChunk(rows: ReturnType<typeof toRow>[]): Promise<number> {
    const columns = [
      'kind',
      'provider',
      'messageId',
      'recipient',
      'fromAddress',
      'subject',
      'at',
      'reason',
      'code',
      'permanent',
    ];
    const params: unknown[] = [];
    const tuples = rows.map((row) => {
      const placeholders = columns.map((column) => {
        params.push((row as Record<string, unknown>)[column]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    const columnList = columns.map((c) => `"${c}"`).join(', ');
    const result = await this.repo.query(
      `INSERT INTO "mail_events" (${columnList})
       VALUES ${tuples.join(', ')}
       ON CONFLICT ("provider", "messageId", "recipient") DO UPDATE SET
         "kind" = excluded."kind",
         "subject" = excluded."subject",
         "at" = excluded."at",
         "reason" = excluded."reason",
         "code" = excluded."code",
         "permanent" = excluded."permanent",
         "fromAddress" = excluded."fromAddress",
         "updatedAt" = now()
       WHERE excluded."at" >= "mail_events"."at"
       RETURNING "id"`,
      params,
    );
    return Array.isArray(result) ? result.length : 0;
  }

  /** Everything in a window, oldest first, for the aggregator to fold. */
  async between(from: Date, to: Date): Promise<DeliveryEvent[]> {
    const rows = await this.repo
      .createQueryBuilder('e')
      .where('e.at >= :from AND e.at <= :to', { from, to })
      .orderBy('e.at', 'ASC')
      .getMany();
    return rows.map(toEvent);
  }

  /** One page of the activity list, newest first — the order a reader scans in. */
  async page(query: MailEventQuery): Promise<MailEventPage> {
    const qb = this.repo.createQueryBuilder('e');

    if (query.from) qb.andWhere('e.at >= :from', { from: query.from });
    if (query.to) qb.andWhere('e.at <= :to', { to: query.to });
    if (query.kinds?.length)
      qb.andWhere('e.kind IN (:...kinds)', { kinds: query.kinds });
    if (query.fromAddress) {
      qb.andWhere('LOWER(e.fromAddress) = :sender', {
        sender: query.fromAddress.trim().toLowerCase(),
      });
    }
    if (query.search?.trim()) {
      qb.andWhere('(e.recipient ILIKE :q OR e.fromAddress ILIKE :q)', {
        q: `%${query.search.trim()}%`,
      });
    }

    qb.orderBy('e.at', 'DESC')
      .take(Math.min(query.limit ?? 50, MAX_PAGE))
      .skip(query.offset ?? 0);

    if (!query.withTotal) {
      const rows = await qb.getMany();
      return { events: rows.map(toEvent), total: rows.length };
    }

    const [rows, total] = await qb.getManyAndCount();
    return { events: rows.map(toEvent), total };
  }

  /**
   * The newest outcome we hold **for one provider**, so a poll resumes instead
   * of re-reading everything.
   *
   * Per provider, not overall. A shared cursor is a data-loss bug the moment a
   * second connection exists: a busy provider drags the mark forward and the
   * quiet one's next poll starts after events it has never read, which are then
   * never read at all. It bites hardest at onboarding, where a new connection
   * would begin its backfill at the *other* provider's newest timestamp and
   * silently skip its entire history.
   */
  async newestAt(provider: string): Promise<Date | null> {
    const row = await this.repo
      .createQueryBuilder('e')
      .select('MAX(e.at)', 'max')
      .where('e.provider = :provider', { provider })
      .getRawOne<{ max: Date | null }>();
    return row?.max ?? null;
  }

  /**
   * Drop what is past retention.
   *
   * Deleting other people's addresses is the point, not housekeeping — see the
   * note on the entity. Suppressions are on no such clock.
   */
  async purge(): Promise<number> {
    const cutoff = new Date(
      Date.now() - MAIL_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('at < :cutoff', { cutoff })
      .execute();
    const removed = result.affected ?? 0;
    if (removed > 0) {
      this.logger.log(
        `[mail] purged ${removed} delivery events older than ${MAIL_EVENT_RETENTION_DAYS} days`,
      );
    }
    return removed;
  }
}

function toRow(event: DeliveryEvent) {
  const recipient = event.recipient?.trim().toLowerCase();
  const at = new Date(event.at);
  // A row without a recipient or a usable timestamp cannot be deduplicated or
  // windowed, so it would only ever be noise in a count.
  if (!event.messageId || !recipient || Number.isNaN(at.getTime())) return null;

  return {
    kind: event.kind as MailEventKind,
    provider: event.provider,
    messageId: event.messageId,
    recipient,
    fromAddress: event.from?.trim().toLowerCase() ?? null,
    subject: event.subject ?? null,
    at,
    reason: event.reason ?? null,
    code: event.code ?? null,
    permanent: event.permanent ?? null,
  };
}

function toEvent(row: MailEventEntity): DeliveryEvent {
  return {
    kind: row.kind as DeliveryEventKind,
    provider: row.provider as DeliveryEvent['provider'],
    messageId: row.messageId,
    recipient: row.recipient,
    at: row.at.toISOString(),
    ...(row.fromAddress ? { from: row.fromAddress } : {}),
    ...(row.subject ? { subject: row.subject } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.code !== null ? { code: row.code } : {}),
    ...(row.permanent !== null ? { permanent: row.permanent } : {}),
  };
}
