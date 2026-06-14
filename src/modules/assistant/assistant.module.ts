import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InferenceModule } from '../inference/inference.module';
import { McpModule } from '../mcp/mcp.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { InfrastructureOperationsModule } from '../infrastructure/operations/infrastructure-operations.module';
import { TemplatesModule } from '../templates/templates.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { ScalingModule } from '../scaling/scaling.module';
import { AssistantMessageLogEntity } from './entities/assistant-message-log.entity';
import { AssistantAuditRepository } from './repositories/assistant-audit.repository';
import { AssistantLlmService } from './services/assistant-llm.service';
import { ModelParamPolicyService } from './services/model-param-policy.service';
import { AssistantGuardService } from './services/assistant-guard.service';
import { AssistantInferenceService } from './services/assistant-inference.service';
import { AssistantService } from './services/assistant.service';
import { AssistantAgentService } from './services/assistant-agent.service';
import { KnowledgeService } from './services/knowledge.service';
import { AssistantRecommendationsService } from './services/assistant-recommendations.service';
import { AssistantController } from './controllers/assistant.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AssistantMessageLogEntity]),
    InferenceModule,
    McpModule,
    CatalogModule,
    ApplicationsModule,
    ObservabilityModule,
    ClustersModule,
    InfrastructureOperationsModule,
    TemplatesModule,
    RepositoriesModule,
    ScalingModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantAgentService,
    AssistantInferenceService,
    AssistantLlmService,
    ModelParamPolicyService,
    AssistantGuardService,
    KnowledgeService,
    AssistantRecommendationsService,
    AssistantAuditRepository,
  ],
  // Reusable inference plumbing for other modules (e.g. the DB console copilot):
  // endpoint resolution (native/BYO/default) + OpenAI-compatible transport with param recovery.
  exports: [AssistantInferenceService, AssistantLlmService],
})
export class AssistantModule {}
