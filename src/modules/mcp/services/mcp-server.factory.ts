import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogService } from '../../catalog/services/catalog.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { LokiQueryService } from '../../observability/services/loki-query.service';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpScopeResolver } from './mcp-scope.resolver';
import { McpToolContext } from '../tools/mcp-tool.util';
import { registerCatalogTools } from '../tools/catalog.tools';
import { registerSpecTools } from '../tools/spec.tools';
import { registerApplicationTools } from '../tools/application.tools';
import { registerObservabilityTools } from '../tools/observability.tools';

export const MCP_SERVER_NAME = 'flui';
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * Builds a stateless MCP server scoped to one authenticated principal. Tools are
 * thin adapters over existing Nest services; the principal's resolved scopes and
 * the destructive-enablement flag are captured per request so every tool gates
 * and audits against the caller, not shared state.
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly resolver: McpScopeResolver,
    private readonly audit: McpAuditRepository,
    private readonly config: ConfigService,
    private readonly catalog: CatalogService,
    private readonly apps: ApplicationService,
    private readonly deploy: ApplicationDeployService,
    private readonly loki: LokiQueryService,
  ) {}

  build(user: AuthenticatedUser): McpServer {
    const server = new McpServer({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    });

    const ctx: McpToolContext = {
      user,
      scopes: this.resolver.resolve(user),
      allowDestructive:
        this.config.get<string>('MCP_ALLOW_DESTRUCTIVE') === 'true',
      audit: this.audit,
      services: {
        catalog: this.catalog,
        apps: this.apps,
        deploy: this.deploy,
        loki: this.loki,
      },
    };

    registerCatalogTools(server, ctx);
    registerSpecTools(server, ctx);
    registerApplicationTools(server, ctx);
    registerObservabilityTools(server, ctx);

    return server;
  }
}
