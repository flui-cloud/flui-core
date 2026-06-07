import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssistantMessageLogEntity } from '../entities/assistant-message-log.entity';

@Injectable()
export class AssistantAuditRepository {
  constructor(
    @InjectRepository(AssistantMessageLogEntity)
    private readonly repo: Repository<AssistantMessageLogEntity>,
  ) {}

  async record(data: {
    userId: string;
    model: string;
    source: string;
    messageCount: number;
  }): Promise<void> {
    await this.repo.save(
      this.repo.create({
        user_id: data.userId,
        model: data.model,
        source: data.source,
        message_count: data.messageCount,
      }),
    );
  }
}
