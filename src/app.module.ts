import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { migrations } from './migrations';
import { AccessModule } from './modules/access/access.module';
import { AdoptionModule } from './modules/adoption/adoption.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { entities } from './config/entities';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstancesModule } from './modules/instances/instances.moduel';
import { ManagementModule } from './modules/management/management.module';
import { InferenceModule } from './modules/inference/inference.module';
import { MailModule } from './modules/mail/mail.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { McpModule } from './modules/mcp/mcp.module';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { TerminalModule } from './modules/terminal/terminal.module';
import { RepositoriesModule } from './modules/repositories/repositories.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { ImagesModule } from './modules/images/images.module';
import { CacheModule } from './modules/common/cache/cache.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { HealthModule } from './modules/common/health/health.module';
import { StartupHealthCheckService } from './modules/common/health/startup-health-check.service';
import { DnsModule } from './modules/dns/dns.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { AppBuildsModule } from './modules/app-builds/app-builds.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { IamModule } from './modules/iam/iam.module';
import { SandboxModule } from './modules/sandbox/sandbox.module';
import { SandboxFenceGuard } from './modules/sandbox/guards/sandbox-fence.guard';
import { PermissionsGuard } from './modules/iam/guards/permissions.guard';
import { SectionAccessGuard } from './modules/iam/guards/section-access.guard';
import { ActionCycleGuard } from './modules/action-cycle/action-cycle.guard';
import { ActionCycleModule } from './modules/action-cycle/action-cycle.module';
import { OperatingContextModule } from './modules/operating-context/operating-context.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ImageRegistryModule } from './modules/image-registry/image-registry.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { ScalingModule } from './modules/scaling/scaling.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { AuthzModule } from './modules/authz/authz.module';
import { BackupsModule } from './modules/backups/backups.module';
import { DbLifecycleModule } from './modules/db-lifecycle/db-lifecycle.module';
import { StorageModule } from './modules/storage/storage.module';
import { AppMigrationModule } from './modules/app-migration/app-migration.module';
import { FullMigrationModule } from './modules/full-migration/full-migration.module';
import { VisualizationsModule } from './modules/visualizations/visualizations.module';
import { TopologyModule } from './modules/topology/topology.module';
import { DatabaseConsoleModule } from './modules/database-console/database-console.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { DemoModule } from './modules/demo/demo.module';
import { MaskModule } from './modules/mask/mask.module';
import { PlatformUpdatesModule } from './modules/platform-updates/platform-updates.module';

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
        entities,
        // Prod aligns the schema through versioned migrations run at boot;
        // synchronize (auto-DDL) is dev-only — in prod it can drop/alter
        // destructively and drifts silently when the image adds columns.
        synchronize: configService.get('NODE_ENV') !== 'production',
        migrationsRun: configService.get('NODE_ENV') === 'production',
        migrations,
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
    AdoptionModule,
    InstancesModule,
    ManagementModule,
    InferenceModule,
    MailModule,
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
    DemoModule,
    VisualizationsModule,
    TopologyModule,
    DatabaseConsoleModule,
    IamModule,
    ProjectsModule,
    SandboxModule,
    ActionCycleModule,
    OperatingContextModule,
    MaskModule,
    PlatformUpdatesModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Runs before the permission and section gates: a sandbox guest is refused at
    // the door of an area, not at the ownership check inside it.
    {
      provide: APP_GUARD,
      useClass: SandboxFenceGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SectionAccessGuard,
    },
    // Fifth, and last of the global chain, on purpose: by the time an agent's
    // request reaches the action cycle the fence has decided the route is
    // callable at all and IAM has decided the person may. A concession can
    // therefore only ever remove the *pause* on something already permitted —
    // it cannot widen a boundary.
    //
    // "Last" means last among these. `AppAccessGuard` is applied per controller
    // with `@UseGuards`, and Nest runs global guards before controller ones, so
    // the resource-level answer arrives *after* this. The invariant survives —
    // a concession removes the pause and that guard still refuses what the
    // caller may not touch — but a request can be raised for a resource the
    // agent would have been refused anyway, and a person can be asked to allow
    // something that then answers 403.
    {
      provide: APP_GUARD,
      useClass: ActionCycleGuard,
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
