import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessModule } from './modules/access/access.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SSHKeyEntity } from './modules/access/entities/ssh-key.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProviderCredentialsEntity } from './modules/access/entities/credentials.entity';
import { InstancesModule } from './modules/instances/instances.moduel';
import { ApiTokenEntity } from './modules/access/entities/api-token.entity';
import { ProviderConfigurationEntity } from './modules/management/entities/provider-configuration.entity';
import { ManagementModule } from './modules/management/management.module';
import { InferenceModule } from './modules/inference/inference.module';
import { InferenceConnectionEntity } from './modules/inference/entities/inference-connection.entity';
import { AssistantModule } from './modules/assistant/assistant.module';
import { AssistantMessageLogEntity } from './modules/assistant/entities/assistant-message-log.entity';
import { McpModule } from './modules/mcp/mcp.module';
import { McpToolCallLogEntity } from './modules/mcp/entities/mcp-tool-call-log.entity';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { InfrastructureOperationEntity } from './modules/infrastructure/servers/entities/infrastructure-operations.entity';
import { ServerEntity } from './modules/infrastructure/servers/entities/server.entity';
import { ClusterEntity } from './modules/infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from './modules/infrastructure/clusters/entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from './modules/infrastructure/clusters/entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from './modules/infrastructure/clusters/entities/volume-billable-interval.entity';
import { CAKeypairEntity } from './modules/access/entities/ca-keypair.entity';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminalModule } from './modules/terminal/terminal.module';
import { RepositoriesModule } from './modules/repositories/repositories.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { RepositoryEntity } from './modules/repositories/entities/repository.entity';
import { RepositoryCredentialEntity } from './modules/repositories/entities/repository-credential.entity';
import { GitHubIntegrationConfigEntity } from './modules/repositories/entities/github-integration-config.entity';
import { GitHubAppInstallationEntity } from './modules/repositories/entities/github-app-installation.entity';
import { GithubUserTokenEntity } from './modules/repositories/entities/github-user-token.entity';
import { GithubAppManifestStateEntity } from './modules/repositories/entities/github-app-manifest-state.entity';
import { ImagesModule } from './modules/images/images.module';
import { ClusterFirewallEntity } from './modules/infrastructure/firewalls/entities/cluster-firewall.entity';
import { FirewallEntity } from './modules/infrastructure/firewalls/entities/firewall.entity';
import { VNetEntity } from './modules/infrastructure/vnets/entities/vnet.entity';
import { VNetSubnetEntity } from './modules/infrastructure/vnets/entities/vnet-subnet.entity';
import { VNetRouteEntity } from './modules/infrastructure/vnets/entities/vnet-route.entity';
import { CacheModule } from './modules/common/cache/cache.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { HealthModule } from './modules/common/health/health.module';
import { StartupHealthCheckService } from './modules/common/health/startup-health-check.service';
import { DnsModule } from './modules/dns/dns.module';
import { DnsZoneEntity } from './modules/dns/entities/dns-zone.entity';
import { DnsZoneReplicaEntity } from './modules/dns/entities/dns-zone-replica.entity';
import { ClusterDnsZoneEntity } from './modules/dns/entities/cluster-dns-zone.entity';
import { AppEndpointEntity } from './modules/dns/entities/app-endpoint.entity';
import { WildcardCertificateEntity } from './modules/dns/entities/wildcard-certificate.entity';
import { SanCertificateEntity } from './modules/dns/entities/san-certificate.entity';
import { ApplicationsModule } from './modules/applications/applications.module';
import { ApplicationEntity } from './modules/applications/entities/application.entity';
import { AppRevisionEntity } from './modules/applications/entities/app-revision.entity';
import { AppResourceEntity } from './modules/applications/entities/app-resource.entity';
import { AppBuildsModule } from './modules/app-builds/app-builds.module';
import { AppBuildEntity } from './modules/app-builds/entities/app-build.entity';
import { BuildCacheSnapshotEntity } from './modules/app-builds/entities/build-cache-snapshot.entity';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { IamModule } from './modules/iam/iam.module';
import { PermissionsGuard } from './modules/iam/guards/permissions.guard';
import { SectionAccessGuard } from './modules/iam/guards/section-access.guard';
import { IamRoleBindingEntity } from './modules/iam/entities/iam-role-binding.entity';
import { IamGroupEntity } from './modules/iam/entities/iam-group.entity';
import { UserEntity } from './modules/auth/entities/user.entity';
import { RefreshTokenEntity } from './modules/auth/entities/refresh-token.entity';
import { ApiKeyEntity } from './modules/auth/entities/api-key.entity';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { FrameworkBuildScoresEntity } from './modules/frameworks/framework-core/entities/framework-build-scores.entity';
import { ImageRegistryModule } from './modules/image-registry/image-registry.module';
import { ImageEntity } from './modules/image-registry/entities/image.entity';
import { TemplatesModule } from './modules/templates/templates.module';
import { ScalingModule } from './modules/scaling/scaling.module';
import { CrashDiagnosisEntity } from './modules/scaling/entities/crash-diagnosis.entity';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CatalogAppDefinitionEntity } from './modules/catalog/entities/catalog-app-definition.entity';
import { CatalogInstallEntity } from './modules/catalog/entities/catalog-install.entity';
import { ObjectStoreShareEntity } from './modules/database-console/entities/object-store-share.entity';
import { AuthzModule } from './modules/authz/authz.module';
import { ClusterAuthzInstallEntity } from './modules/authz/entities/cluster-authz-install.entity';
import { BackupsModule } from './modules/backups/backups.module';
import { DbLifecycleModule } from './modules/db-lifecycle/db-lifecycle.module';
import { StorageModule } from './modules/storage/storage.module';
import { BackupDestinationEntity } from './modules/backups/entities/backup-destination.entity';
import { BackupPolicyEntity } from './modules/backups/entities/backup-policy.entity';
import { BackupPolicyDestinationEntity } from './modules/backups/entities/backup-policy-destination.entity';
import { BackupJobEntity } from './modules/backups/entities/backup-job.entity';
import { BackupArtifactEntity } from './modules/backups/entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from './modules/backups/entities/backup-artifact-location.entity';
import { RestoreJobEntity } from './modules/backups/entities/restore-job.entity';
import { DbReplicationLinkEntity } from './modules/db-lifecycle/entities/db-replication-link.entity';
import { DbMigrationEntity } from './modules/db-lifecycle/entities/db-migration.entity';
import { AppMigrationModule } from './modules/app-migration/app-migration.module';
import { AppMigrationEntity } from './modules/app-migration/entities/app-migration.entity';
import { FullMigrationModule } from './modules/full-migration/full-migration.module';
import { FullMigrationEntity } from './modules/full-migration/entities/full-migration.entity';
import { VisualizationsModule } from './modules/visualizations/visualizations.module';
import { TopologyModule } from './modules/topology/topology.module';
import { DatabaseConsoleModule } from './modules/database-console/database-console.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProjectEntity } from './modules/projects/entities/project.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    CacheModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get('DB_PORT', 5432),
        username: configService.get('DB_USERNAME', 'developer'),
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_NAME', 'myapp_dev'),
        extra: {
          options: '-c timezone=UTC',
        },
        entities: [
          SSHKeyEntity,
          ProviderCredentialsEntity,
          ApiTokenEntity,
          ProviderConfigurationEntity,
          InfrastructureOperationEntity,
          ServerEntity,
          ClusterEntity,
          ClusterNodeEntity,
          NodeBillableIntervalEntity,
          VolumeBillableIntervalEntity,
          CAKeypairEntity,
          RepositoryEntity,
          RepositoryCredentialEntity,
          GitHubIntegrationConfigEntity,
          GitHubAppInstallationEntity,
          GithubUserTokenEntity,
          GithubAppManifestStateEntity,
          ClusterFirewallEntity,
          FirewallEntity,
          VNetEntity,
          VNetSubnetEntity,
          VNetRouteEntity,
          DnsZoneEntity,
          DnsZoneReplicaEntity,
          ClusterDnsZoneEntity,
          AppEndpointEntity,
          WildcardCertificateEntity,
          SanCertificateEntity,
          ApplicationEntity,
          AppRevisionEntity,
          AppResourceEntity,
          AppBuildEntity,
          BuildCacheSnapshotEntity,
          UserEntity,
          RefreshTokenEntity,
          ApiKeyEntity,
          FrameworkBuildScoresEntity,
          ImageEntity,
          CrashDiagnosisEntity,
          CatalogAppDefinitionEntity,
          CatalogInstallEntity,
          ObjectStoreShareEntity,
          ClusterAuthzInstallEntity,
          BackupDestinationEntity,
          BackupPolicyEntity,
          BackupPolicyDestinationEntity,
          BackupJobEntity,
          BackupArtifactEntity,
          BackupArtifactLocationEntity,
          RestoreJobEntity,
          InferenceConnectionEntity,
          AssistantMessageLogEntity,
          McpToolCallLogEntity,
          IamRoleBindingEntity,
          IamGroupEntity,
          ProjectEntity,
          DbReplicationLinkEntity,
          DbMigrationEntity,
          AppMigrationEntity,
          FullMigrationEntity,
        ],
        synchronize: true, // Solo per development!
      }),
      inject: [ConfigService],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        prefix: configService.get('BULL_PREFIX') || undefined,
        redis: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get('REDIS_PORT', 6379),
          password: configService.get('REDIS_PASSWORD'),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: (times: number) => Math.min(times * 200, 5000),
        },
      }),
      inject: [ConfigService],
    }),
    AccessModule,
    InstancesModule,
    ManagementModule,
    InferenceModule,
    AssistantModule,
    McpModule,
    InfrastructureModule,
    TerminalModule,
    RepositoriesModule,
    CredentialsModule,
    ImagesModule,
    ObservabilityModule,
    DnsModule,
    ApplicationsModule,
    AppBuildsModule,
    WebhooksModule,
    ImageRegistryModule,
    TemplatesModule,
    HealthModule,
    AuthModule,
    ScalingModule,
    CatalogModule,
    AuthzModule,
    StorageModule,
    BackupsModule,
    DbLifecycleModule,
    AppMigrationModule,
    FullMigrationModule,
    VisualizationsModule,
    TopologyModule,
    DatabaseConsoleModule,
    IamModule,
    ProjectsModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SectionAccessGuard,
    },
  ],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  constructor(
    private readonly startupHealthCheckService: StartupHealthCheckService,
  ) {}

  async onModuleInit() {
    const result = await this.startupHealthCheckService.performStartupChecks();

    if (!result.success) {
      this.logger.error(result.errorMessage);
      process.exit(1);
    }
  }
}
