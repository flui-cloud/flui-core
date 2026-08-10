import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CatalogService } from '../../catalog/services/catalog.service';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { AppManagementService } from '../../applications/services/app-management.service';
import { ScheduledJobsService } from '../../applications/services/scheduled-jobs.service';
import { GatewayService } from '../../applications/services/gateway.service';
import { ApplicationReleaseService } from '../../applications/services/application-release.service';
import { ApplicationSourceDeployService } from '../../applications/services/application-source-deploy.service';
import { TemplatesService } from '../../templates/templates.service';
import { RepositoriesService } from '../../repositories/services/repositories.service';
import { GitHubOAuthService } from '../../repositories/services/github-oauth.service';
import { GithubAppUserAuthService } from '../../repositories/services/github-app-user-auth.service';
import { GithubAppManifestStateService } from '../../repositories/services/github-app-manifest-state.service';
import { LokiQueryService } from '../../observability/services/loki-query.service';
import { ApplicationTrafficService } from '../../observability/services/application-traffic.service';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { InfrastructureOperationsService } from '../../infrastructure/operations/infrastructure-operations.service';
import { PodDebugService } from '../../scaling/services/pod-debug.service';
import { BackupPoliciesService } from '../../backups/services/backup-policies.service';
import { BackupJobsService } from '../../backups/services/backup-jobs.service';
import { BackupStatusService } from '../../backups/services/backup-status.service';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { FullMigrationService } from '../../full-migration/services/full-migration.service';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpScopeResolver } from './mcp-scope.resolver';
import {
  McpToolContext,
  isExecutable,
  runTool,
  toolInputSchema,
} from '../tools/mcp-tool.util';
import { ALL_TOOLS } from '../tools/tool-registry';

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
    private readonly installer: CatalogInstallerService,
    private readonly apps: ApplicationService,
    private readonly deploy: ApplicationDeployService,
    private readonly management: AppManagementService,
    private readonly releases: ApplicationReleaseService,
    private readonly sourceDeploy: ApplicationSourceDeployService,
    private readonly templates: TemplatesService,
    private readonly repos: RepositoriesService,
    private readonly github: GitHubOAuthService,
    private readonly githubAuth: GithubAppUserAuthService,
    private readonly githubManifest: GithubAppManifestStateService,
    private readonly loki: LokiQueryService,
    private readonly traffic: ApplicationTrafficService,
    private readonly alertEvents: AlertEventsService,
    private readonly clusters: ClustersService,
    private readonly operations: InfrastructureOperationsService,
    private readonly podDebug: PodDebugService,
    private readonly backupPolicies: BackupPoliciesService,
    private readonly backupJobs: BackupJobsService,
    private readonly backupStatus: BackupStatusService,
    private readonly appMigration: AppMigrationService,
    private readonly dbMigration: DbMigrationService,
    private readonly fullMigration: FullMigrationService,
    private readonly scheduledJobs: ScheduledJobsService,
    private readonly gateway: GatewayService,
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
      surface: 'mcp',
      audit: this.audit,
      services: {
        catalog: this.catalog,
        installer: this.installer,
        apps: this.apps,
        deploy: this.deploy,
        management: this.management,
        releases: this.releases,
        sourceDeploy: this.sourceDeploy,
        templates: this.templates,
        repos: this.repos,
        github: this.github,
        githubAuth: this.githubAuth,
        githubManifest: this.githubManifest,
        loki: this.loki,
        traffic: this.traffic,
        alertEvents: this.alertEvents,
        clusters: this.clusters,
        operations: this.operations,
        podDebug: this.podDebug,
        backupPolicies: this.backupPolicies,
        backupJobs: this.backupJobs,
        backupStatus: this.backupStatus,
        appMigration: this.appMigration,
        dbMigration: this.dbMigration,
        fullMigration: this.fullMigration,
        scheduledJobs: this.scheduledJobs,
        gateway: this.gateway,
      },
    };

    for (const def of ALL_TOOLS) {
      // A tool this principal can never execute is not advertised at all: listing it
      // costs the agent context, invites a plan built around it, and pays back only a
      // refusal. runGated still guards execution — this only trims what is offered.
      if (!isExecutable(ctx, def)) continue;

      server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: toolInputSchema(def.inputSchema),
        },
        (args) => runTool(ctx, def, args),
      );
    }

    return server;
  }
}
