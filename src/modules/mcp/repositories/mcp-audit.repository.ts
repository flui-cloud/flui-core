import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';

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
  }): Promise<void> {
    await this.repo.save(
      this.repo.create({
        user_id: data.userId,
        tool: data.tool,
        scope: data.scope,
        allowed: data.allowed,
        error: data.error ?? null,
      }),
    );
  }
}
