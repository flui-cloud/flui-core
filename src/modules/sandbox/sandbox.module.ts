import { forwardRef, Module } from '@nestjs/common';
import { SandboxWaitlistEntity } from './entities/sandbox-waitlist.entity';
import { SandboxGateModule } from './gate/sandbox-slot-gate';
import { ApplicationsModule } from '../applications/applications.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IamModule } from '../iam/iam.module';
import { AuthModule } from '../auth/auth.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EgressModule } from '../infrastructure/egress/egress.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SandboxController } from './sandbox.controller';
import { SandboxClaimController } from './sandbox-claim.controller';
import { SandboxVisitorTestController } from './sandbox-visitor-test.controller';
import {
  SandboxVisitorTestService,
  visitorTestRouteEnabled,
} from './services/sandbox-visitor-test.service';
import { SandboxVisitorEntity } from './entities/sandbox-visitor.entity';
import { SandboxVisitorPoolEntity } from './entities/sandbox-visitor-pool.entity';
import { SandboxVisitorAdmissionEntity } from './entities/sandbox-visitor-admission.entity';
import { SandboxVisitorLoginClientEntity } from './entities/sandbox-visitor-login-client.entity';
import { SandboxVisitorController } from './sandbox-visitor.controller';
import { SandboxVisitorUpgradeController } from './sandbox-visitor-upgrade.controller';
import { SandboxVisitorUpgradeEntity } from './entities/sandbox-visitor-upgrade.entity';
import { SandboxVisitorRefusalEntity } from './entities/sandbox-visitor-refusal.entity';
import { SandboxVisitorStatsController } from './sandbox-visitor-stats.controller';
import { VisitorRefusalsService } from './visitors/visitor-refusals.service';
import { VisitorStatsService } from './visitors/visitor-stats.service';
import { VisitorUpgradeService } from './visitors/visitor-upgrade.service';
import { VisitorLinkService } from './visitors/visitor-link.service';
import { VisitorMergeService } from './visitors/visitor-merge.service';
import { AuditModule } from '../audit/audit.module';
import { VISITOR_CONFIG, loadVisitorConfig } from './visitors/visitor.config';
import {
  VISITOR_FETCH,
  VISITOR_THROTTLER,
  VisitorAdmissionService,
} from './visitors/visitor-admission.service';
import { VisitorLoginClientService } from './visitors/visitor-login-client.service';
import { VisitorEntranceSetupService } from './visitors/visitor-entrance-setup.service';
import { VisitorPoolService } from './visitors/visitor-pool.service';
import { VisitorLoginService } from './visitors/visitor-login.service';
import { VisitorSweepService } from './visitors/visitor-sweep.service';
import { VisitorSchedulerService } from './visitors/visitor-scheduler.service';
import { sharedThrottlerStorage } from '../../common/throttling/redis-throttler.storage';
import { OidcModule } from '../oidc/oidc.module';
import { SandboxFenceGuard } from './guards/sandbox-fence.guard';
import { SandboxProjectionInterceptor } from './interceptors/sandbox-projection.interceptor';
import { SandboxCapacityService } from './services/sandbox-capacity.service';
import { SandboxEntryService } from './services/sandbox-entry.service';
import { SandboxQuotaService } from './services/sandbox-quota.service';
import { SandboxScopeService } from './services/sandbox-scope.service';
import { SandboxPrepullService } from './services/sandbox-prepull.service';
import { SandboxCpuAlertService } from './services/sandbox-cpu-alert.service';
import { SandboxNoticeMailService } from './services/sandbox-notice-mail.service';
import { SandboxWaitlistService } from './services/sandbox-waitlist.service';
import { SandboxWaitlistAlertService } from './services/sandbox-waitlist-alert.service';
import { SandboxCapacityAlertService } from './services/sandbox-capacity-alert.service';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import { SandboxTenantService } from './services/sandbox-tenant.service';
import { SandboxSchedulerService } from './services/sandbox-scheduler.service';
import { SandboxStorageQuotaService } from './services/sandbox-storage-quota.service';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { ApiKeyEntity } from '../auth/entities/api-key.entity';
import { IamRoleBindingEntity } from '../iam/entities/iam-role-binding.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { CatalogAppDefinitionEntity } from '../catalog/entities/catalog-app-definition.entity';
import { SANDBOX_CONFIG, loadSandboxConfig } from './sandbox.config';
import { DatabaseConsoleModule } from '../database-console/database-console.module';
import { DnsModule } from '../dns/dns.module';
import { ProjectsModule } from '../projects/projects.module';
import { MailModule } from '../mail/mail.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { FluiRegistryModule } from '../flui-registry/flui-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SandboxTenantEntity,
      SandboxWaitlistEntity,
      SandboxVisitorEntity,
      SandboxVisitorPoolEntity,
      SandboxVisitorAdmissionEntity,
      SandboxVisitorLoginClientEntity,
      SandboxVisitorUpgradeEntity,
      SandboxVisitorRefusalEntity,
      UserEntity,
      ApiKeyEntity,
      IamRoleBindingEntity,
      ApplicationEntity,
      ClusterEntity,
      // Bound at TypeORM level rather than through CatalogModule, which is
      // already a forwardRef here: the pre-pull only reads image references.
      CatalogAppDefinitionEntity,
    ]),
    IamModule,
    AuthModule,
    AuditModule,
    OidcModule,
    SharedInfrastructureModule,
    EgressModule,
    EncryptionModule,
    DnsModule,
    ProjectsModule,
    SandboxGateModule,
    MailModule,
    DatabaseConsoleModule,
    forwardRef(() => CatalogModule),
    // For the one path that removes a guest's workload: the same service a
    // person's own delete goes through, not a copy of it beside the reaper.
    forwardRef(() => ApplicationsModule),
    forwardRef(() => RepositoriesModule),
    FluiRegistryModule,
    // For the one alert nothing in the cluster can raise: the demo being full is
    // arithmetic over the tenancy table, not a metric anything scrapes.
    ObservabilityModule,
    // The gate that decides whether one more area's work could start — the same
    // one that refuses a guest's install, so the warning cannot disagree with it.
    forwardRef(() => ClustersModule),
  ],
  controllers: [
    SandboxController,
    SandboxClaimController,
    SandboxVisitorController,
    SandboxVisitorUpgradeController,
    SandboxVisitorStatsController,
    ...(visitorTestRouteEnabled() ? [SandboxVisitorTestController] : []),
  ],
  providers: [
    { provide: SANDBOX_CONFIG, useFactory: () => loadSandboxConfig() },
    SandboxFenceGuard,
    SandboxScopeService,
    // Registered here rather than in AppModule: a global interceptor is built in
    // the context of the module that declares it, and this one needs the scope
    // service that lives alongside it.
    { provide: APP_INTERCEPTOR, useClass: SandboxProjectionInterceptor },
    SandboxCapacityService,
    SandboxEntryService,
    SandboxQuotaService,
    SandboxPrepullService,
    SandboxCapacityAlertService,
    SandboxCpuAlertService,
    SandboxNoticeMailService,
    SandboxWaitlistService,
    SandboxWaitlistAlertService,
    SandboxReserveService,
    SandboxTenantService,
    SandboxSchedulerService,
    SandboxStorageQuotaService,
    SandboxVisitorTestService,
    { provide: VISITOR_CONFIG, useFactory: () => loadVisitorConfig() },
    { provide: VISITOR_THROTTLER, useFactory: () => sharedThrottlerStorage() },
    { provide: VISITOR_FETCH, useValue: fetch },
    VisitorAdmissionService,
    VisitorLoginClientService,
    VisitorEntranceSetupService,
    VisitorPoolService,
    VisitorLoginService,
    VisitorSweepService,
    VisitorSchedulerService,
    VisitorMergeService,
    VisitorLinkService,
    VisitorUpgradeService,
    VisitorRefusalsService,
    VisitorStatsService,
  ],
  exports: [
    SandboxFenceGuard,
    SandboxQuotaService,
    SandboxReserveService,
    SandboxEntryService,
  ],
})
export class SandboxModule {}
