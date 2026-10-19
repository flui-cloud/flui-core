import { MailModule } from '../mail/mail.module';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { InferenceModule } from '../inference/inference.module';
import { IamModule } from '../iam/iam.module';
import { McpModule } from '../mcp/mcp.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { DnsModule } from '../dns/dns.module';
import { InfrastructureOperationsModule } from '../infrastructure/operations/infrastructure-operations.module';
import { TemplatesModule } from '../templates/templates.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { ScalingModule } from '../scaling/scaling.module';
import { BackupsModule } from '../backups/backups.module';
import { DbLifecycleModule } from '../db-lifecycle/db-lifecycle.module';
import { AppMigrationModule } from '../app-migration/app-migration.module';
import { FullMigrationModule } from '../full-migration/full-migration.module';
import { UserEntity } from '../auth/entities/user.entity';
import { AssistantMessageLogEntity } from './entities/assistant-message-log.entity';
import { AssistantAuditRepository } from './repositories/assistant-audit.repository';
import { AssistantLlmService } from './services/assistant-llm.service';
import { ModelParamPolicyService } from './services/model-param-policy.service';
import { AssistantGuardService } from './services/assistant-guard.service';
import { AssistantInferenceService } from './services/assistant-inference.service';
import { AssistantService } from './services/assistant.service';
import { AssistantAgentService } from './services/assistant-agent.service';
import { AssistantToolExecutionService } from './services/assistant-tool-execution.service';
import { AssistantPendingActionsService } from './services/assistant-pending-actions.service';
import { AssistantProposalsService } from './services/assistant-proposals.service';
import { AssistantGenerationService } from './services/assistant-generation.service';
import { ActionCycleRoutes } from './services/action-cycle-routes.service';
import { KnowledgeService } from './services/knowledge.service';
import { AssistantRecommendationsService } from './services/assistant-recommendations.service';
import { AssistantController } from './controllers/assistant.controller';
import {
  GUEST_INFERENCE_THROTTLER,
  GuestInferenceGuardService,
} from './services/guest-inference-guard.service';
import { GuestInferenceSettingsService } from './services/guest-inference-settings.service';
import {
  API_CONFIG_READER,
  controlApiConfigReader,
} from './services/api-config-reader';
import { AppConfigService } from '../applications/services/app-config.service';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { sharedThrottlerStorage } from '../../common/throttling/redis-throttler.storage';

@Module({
  imports: [
    // Read-only: the chat has to know which routes the action cycle pauses
    // BEFORE it makes a call, and the decorations are the only honest source.
    DiscoveryModule,
    MailModule,
    TypeOrmModule.forFeature([
      AssistantMessageLogEntity,
      UserEntity,
      ClusterEntity,
    ]),
    EncryptionModule,
    InferenceModule,
    McpModule,
    IamModule,
    CatalogModule,
    ApplicationsModule,
    ObservabilityModule,
    ClustersModule,
    DnsModule,
    InfrastructureOperationsModule,
    TemplatesModule,
    RepositoriesModule,
    ScalingModule,
    BackupsModule,
    DbLifecycleModule,
    AppMigrationModule,
    FullMigrationModule,
  ],
  controllers: [AssistantController],
  providers: [
    ActionCycleRoutes,
    AssistantService,
    AssistantAgentService,
    AssistantToolExecutionService,
    AssistantPendingActionsService,
    AssistantProposalsService,
    AssistantGenerationService,
    AssistantInferenceService,
    AssistantLlmService,
    ModelParamPolicyService,
    AssistantGuardService,
    KnowledgeService,
    AssistantRecommendationsService,
    AssistantAuditRepository,
    GuestInferenceSettingsService,
    GuestInferenceGuardService,
    {
      provide: API_CONFIG_READER,
      inject: [getRepositoryToken(ClusterEntity), AppConfigService],
      useFactory: controlApiConfigReader,
    },
    {
      provide: GUEST_INFERENCE_THROTTLER,
      useFactory: () => sharedThrottlerStorage(),
    },
  ],
  // Reusable inference plumbing for other modules (e.g. the DB console copilot):
  // endpoint resolution (native/BYO/default) + OpenAI-compatible transport with param recovery.
  exports: [AssistantInferenceService, AssistantLlmService],
})
export class AssistantModule {}
