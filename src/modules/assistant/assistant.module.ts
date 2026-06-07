import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InferenceModule } from '../inference/inference.module';
import { AssistantMessageLogEntity } from './entities/assistant-message-log.entity';
import { AssistantAuditRepository } from './repositories/assistant-audit.repository';
import { AssistantLlmService } from './services/assistant-llm.service';
import { AssistantGuardService } from './services/assistant-guard.service';
import { AssistantService } from './services/assistant.service';
import { KnowledgeService } from './services/knowledge.service';
import { AssistantController } from './controllers/assistant.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AssistantMessageLogEntity]),
    InferenceModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantLlmService,
    AssistantGuardService,
    KnowledgeService,
    AssistantAuditRepository,
  ],
})
export class AssistantModule {}
