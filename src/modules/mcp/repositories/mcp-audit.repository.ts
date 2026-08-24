import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';
import { Actor } from '../../auth/utils/actor-context';

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
      }),
    );
  }
}
