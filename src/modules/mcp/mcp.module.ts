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

/**
 * Segregated MCP surface: a thin, scope-gated adapter over existing Nest
 * services. No new business logic — tools delegate to catalog / applications /
 * observability services already in the app.
 */
@Module({
  imports: [
    IamModule,
    MailModule,
    ConfigModule,
    TypeOrmModule.forFeature([McpToolCallLogEntity]),
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
  controllers: [McpController],
  providers: [
    McpServerFactory,
    McpScopeResolver,
    McpAuditRepository,
    McpApiClient,
  ],
  exports: [McpScopeResolver, McpAuditRepository, McpApiClient],
})
export class McpModule {}
