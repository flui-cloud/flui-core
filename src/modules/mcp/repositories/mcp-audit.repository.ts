import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';
import { Actor } from '../../auth/utils/actor-context';
import {
  ActivityFilter,
  applyActivityFilter,
} from '../audit/agent-activity.query';

/** One credential's footprint in the register, folded by the database. */
export interface IdentityActivity {
  actorKind: string | null;
  actorKeyId: string | null;
  userId: string;
  calls: number;
  refused: number;
  lastActivityAt: Date;
  lastTool: string | null;
  lastOutcome: string | null;
  lastAllowed: boolean | null;
}

@Injectable()
export class McpAuditRepository {
  constructor(
    @InjectRepository(McpToolCallLogEntity)
    private readonly repo: Repository<McpToolCallLogEntity>,
  ) {}

  async record(data: {
    userId: string;
    tool: string;
    scope: string;
    allowed: boolean;
    error?: string | null;
    outcome?: string | null;
    /** Who acted, beside whom it was acted for. Absent on paths with no request. */
    actor?: Actor;
    /** Already redacted by the caller — this repository never sees raw arguments. */
    args?: Record<string, unknown> | null;
    operationId?: string | null;
    /** The request this call raised, when the action cycle stopped it to ask. */
    proposalId?: string | null;
    /**
     * Which door it came through. Optional because the two agentic surfaces
     * predate the column and a row without it is honest — see
     * `REGISTER_SURFACE_UNKNOWN` — never because a writer may leave it out.
     */
    surface?: string | null;
    /** The answer the writer knew first-hand — see the entity's `grant_id`. */
    grantId?: string | null;
  }): Promise<void> {
    await this.repo.save(
      this.repo.create({
        user_id: data.userId,
        tool: data.tool,
        scope: data.scope,
        allowed: data.allowed,
        error: data.error ?? null,
        outcome: data.outcome ?? null,
        actor_kind: data.actor?.kind ?? null,
        actor_key_id: data.actor?.keyId ?? null,
        args: data.args ?? null,
        operation_id: data.operationId ?? null,
        proposal_id: data.proposalId ?? null,
        surface: data.surface ?? null,
        grant_id: data.grantId ?? null,
      }),
    );
  }

  /**
   * One page of the register, newest first.
   *
   * `id` breaks the tie on `created_at` so that paging is stable: several tool
   * calls in the same millisecond are ordinary on this table — a round trip
   * writes one row per turn — and without a second key a row can appear on two
   * pages or on none.
   */
  async page(
    filter: ActivityFilter,
    limit: number,
    offset: number,
  ): Promise<{ rows: McpToolCallLogEntity[]; total: number }> {
    const qb = applyActivityFilter(this.repo.createQueryBuilder('log'), filter)
      .orderBy('log.created_at', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .take(limit)
      .skip(offset);
    const [rows, total] = await qb.getManyAndCount();
    return { rows, total };
  }

  /** One row, by id, with no ownership opinion — the caller's reach decides. */
  findById(id: string): Promise<McpToolCallLogEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * The last activity of every credential in the filtered set, and how much of
   * it there was.
   *
   * Derived, never stored. `api_keys.lastUsedAt` already exists and answers a
   * different question — when the key last *authenticated*, stamped behind a
   * threshold and rounded — so a key that opened a connection and did nothing
   * is "used" there and silent here. The panel's "last activity" is the second
   * one, and giving it a column of its own would be a second thing to keep
   * true.
   *
   * The fold is done by the database because the alternative is reading the
   * whole table into memory to group it. `array_agg(... ORDER BY ...)` picks
   * the newest row's value per group in the same pass as the counts, which
   * `MAX()` cannot do for a non-comparable column.
   */
  async identities(
    filter: ActivityFilter,
    limit: number,
  ): Promise<IdentityActivity[]> {
    const raw = await applyActivityFilter(
      this.repo.createQueryBuilder('log'),
      filter,
    )
      .select('log.actor_kind', 'actorKind')
      .addSelect('log.actor_key_id', 'actorKeyId')
      .addSelect('log.user_id', 'userId')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('COUNT(*) FILTER (WHERE log.allowed = false)', 'refused')
      .addSelect('MAX(log.created_at)', 'lastActivityAt')
      .addSelect(
        '(array_agg(log.tool ORDER BY log.created_at DESC))[1]',
        'lastTool',
      )
      .addSelect(
        '(array_agg(log.outcome ORDER BY log.created_at DESC))[1]',
        'lastOutcome',
      )
      .addSelect(
        '(array_agg(log.allowed ORDER BY log.created_at DESC))[1]',
        'lastAllowed',
      )
      .groupBy('log.actor_kind')
      .addGroupBy('log.actor_key_id')
      .addGroupBy('log.user_id')
      .orderBy('"lastActivityAt"', 'DESC')
      .limit(limit)
      .getRawMany<RawIdentityRow>();
    // `COUNT` comes back as a string: Postgres bigint has no lossless JS
    // number, so the driver refuses to guess. Coerced here rather than at the
    // three call sites that would each have to remember.
    return raw.map((row) => ({
      ...row,
      calls: Number(row.calls),
      refused: Number(row.refused),
      lastActivityAt: new Date(row.lastActivityAt),
    }));
  }
}

/** The fold as the driver hands it back, before the counts become numbers. */
interface RawIdentityRow
  extends Omit<IdentityActivity, 'calls' | 'refused' | 'lastActivityAt'> {
  calls: string;
  refused: string;
  lastActivityAt: string | Date;
}
