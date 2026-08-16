import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IamModule } from '../iam/iam.module';
import { AuthModule } from '../auth/auth.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SandboxController } from './sandbox.controller';
import { SandboxClaimController } from './sandbox-claim.controller';
import { SandboxFenceGuard } from './guards/sandbox-fence.guard';
import { SandboxQuotaService } from './services/sandbox-quota.service';
import { SandboxSeedService } from './services/sandbox-seed.service';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import { SandboxTenantService } from './services/sandbox-tenant.service';
import { SandboxSchedulerService } from './services/sandbox-scheduler.service';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { IamRoleBindingEntity } from '../iam/entities/iam-role-binding.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { SANDBOX_CONFIG, loadSandboxConfig } from './sandbox.config';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SandboxTenantEntity,
      UserEntity,
      IamRoleBindingEntity,
      ApplicationEntity,
      ClusterEntity,
    ]),
    IamModule,
    AuthModule,
    SharedInfrastructureModule,
    EncryptionModule,
    forwardRef(() => CatalogModule),
  ],
  controllers: [SandboxController, SandboxClaimController],
  providers: [
    { provide: SANDBOX_CONFIG, useFactory: () => loadSandboxConfig() },
    SandboxFenceGuard,
    SandboxQuotaService,
    SandboxSeedService,
    SandboxReserveService,
    SandboxTenantService,
    SandboxSchedulerService,
  ],
  exports: [SandboxFenceGuard, SandboxQuotaService, SandboxReserveService],
})
export class SandboxModule {}
