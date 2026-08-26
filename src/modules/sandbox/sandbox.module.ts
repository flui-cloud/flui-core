import { forwardRef, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IamModule } from '../iam/iam.module';
import { AuthModule } from '../auth/auth.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SandboxController } from './sandbox.controller';
import { SandboxClaimController } from './sandbox-claim.controller';
import { SandboxFenceGuard } from './guards/sandbox-fence.guard';
import { SandboxProjectionInterceptor } from './interceptors/sandbox-projection.interceptor';
import { SandboxCapacityService } from './services/sandbox-capacity.service';
import { SandboxEntryService } from './services/sandbox-entry.service';
import { SandboxHistoryService } from './services/sandbox-history.service';
import { SandboxQuotaService } from './services/sandbox-quota.service';
import { SandboxResumeMailService } from './services/sandbox-resume-mail.service';
import { SandboxScopeService } from './services/sandbox-scope.service';
import { SandboxSeedService } from './services/sandbox-seed.service';
import { SandboxPrepullService } from './services/sandbox-prepull.service';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import { SandboxTenantService } from './services/sandbox-tenant.service';
import { SandboxSchedulerService } from './services/sandbox-scheduler.service';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SandboxTenantEntity,
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
    SharedInfrastructureModule,
    EncryptionModule,
    DnsModule,
    ProjectsModule,
    MailModule,
    DatabaseConsoleModule,
    forwardRef(() => CatalogModule),
  ],
  controllers: [SandboxController, SandboxClaimController],
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
    SandboxHistoryService,
    SandboxQuotaService,
    SandboxResumeMailService,
    SandboxSeedService,
    SandboxPrepullService,
    SandboxReserveService,
    SandboxTenantService,
    SandboxSchedulerService,
  ],
  exports: [
    SandboxFenceGuard,
    SandboxQuotaService,
    SandboxReserveService,
    SandboxEntryService,
  ],
})
export class SandboxModule {}
