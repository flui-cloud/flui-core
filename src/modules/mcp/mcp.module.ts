import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogModule } from '../catalog/catalog.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ObservabilityModule } from '../observability/observability.module';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './services/mcp-server.factory';
import { McpScopeResolver } from './services/mcp-scope.resolver';
import { McpAuditRepository } from './repositories/mcp-audit.repository';
import { McpToolCallLogEntity } from './entities/mcp-tool-call-log.entity';

/**
 * Segregated MCP surface: a thin, scope-gated adapter over existing Nest
 * services. No new business logic — tools delegate to catalog / applications /
 * observability services already in the app.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([McpToolCallLogEntity]),
    CatalogModule,
    ApplicationsModule,
    ObservabilityModule,
  ],
  controllers: [McpController],
  providers: [McpServerFactory, McpScopeResolver, McpAuditRepository],
})
export class McpModule {}
