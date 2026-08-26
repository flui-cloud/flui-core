import { EncryptionModule } from '../shared/encryption/encryption.module';
import { IamModule } from '../iam/iam.module';
import { MailModule } from '../mail/mail.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { McpController } from './mcp.controller';
import { McpServerFactory } from './services/mcp-server.factory';
import { McpScopeResolver } from './services/mcp-scope.resolver';
import { McpApiClient } from './services/mcp-api.client';
import { McpAuditRepository } from './repositories/mcp-audit.repository';
import { McpToolCallLogEntity } from './entities/mcp-tool-call-log.entity';
import { AgentActivityController } from './audit/agent-activity.controller';
import { AgentActivityService } from './audit/agent-activity.service';
import { AgentCallRegister } from './audit/agent-call-register';
import { ApiKeyEntity } from '../auth/entities/api-key.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { AgentConcessionEntity } from '../action-cycle/entities/agent-concession.entity';

/**
 * Segregated MCP surface: a thin, scope-gated adapter over existing Nest
 * services. No new business logic — tools delegate to catalog / applications /
 * observability services already in the app.
 */
@Module({
  imports: [
    EncryptionModule,
    IamModule,
    MailModule,
    ConfigModule,
    // The register read back needs two rows it does not own: the key's name,
    // which is not a foreign key because the log outlives the credential, and
    // the operation a call started, which is where the resource is recorded.
    // Repositories rather than the owning modules' services, so no import cycle
    // is created for two lookups.
    TypeOrmModule.forFeature([
      McpToolCallLogEntity,
      ApiKeyEntity,
      InfrastructureOperationEntity,
      AgentConcessionEntity,
    ]),
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
  controllers: [McpController, AgentActivityController],
  providers: [
    McpServerFactory,
    McpScopeResolver,
    McpAuditRepository,
    McpApiClient,
    AgentActivityService,
    AgentCallRegister,
  ],
  // The register is exported for the action cycle's guard, which is registered
  // as an `APP_GUARD` in `AppModule` and resolves its dependencies from there.
  // The alternative — a second writer to `mcp_tool_call_logs` living beside the
  // guard — is the shape decision 162 was about.
  exports: [
    McpScopeResolver,
    McpAuditRepository,
    McpApiClient,
    AgentCallRegister,
  ],
})
export class McpModule {}
