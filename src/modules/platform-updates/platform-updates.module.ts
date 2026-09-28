import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ApplicationsRepository } from '../applications/repositories/applications.repository';
import { ApplicationsModule } from '../applications/applications.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { BackupsModule } from '../backups/backups.module';
import { BackupPolicyEntity } from '../backups/entities/backup-policy.entity';
import { BackupJobEntity } from '../backups/entities/backup-job.entity';
import { AuditModule } from '../audit/audit.module';
import { PlatformUpdatesController } from './controllers/platform-updates.controller';
import { PlatformUpdatesService } from './services/platform-updates.service';
import { DeclaredImageService } from './services/declared-image.service';
import { ManifestRefreshService } from './services/manifest-refresh.service';
import { ManifestMasterService } from './services/manifest-master.service';
import { ReleaseManifestService } from './services/release-manifest.service';
import { BootstrapFilesService } from './services/bootstrap-files.service';
import { InstallValuesService } from './services/install-values.service';
import { MasterAccessService } from './services/master-access.service';
import { InstallStateService } from './services/install-state.service';
import { InstallSourcesService } from './services/install-sources.service';
import { InstallValuesController } from './controllers/install-values.controller';
import { K3sUpgradeService } from './services/k3s-upgrade.service';
import { K3sUpgradeController } from './controllers/k3s-upgrade.controller';
import {
  PLATFORM_UPDATE_QUEUE,
  PlatformUpdateRunnerService,
} from './services/platform-update-runner.service';
import { PlatformUpdateResumeService } from './services/platform-update-resume.service';
import { PlatformUpdateProcessor } from './processors/platform-update.processor';
import { ImageRolloutService } from './services/image-rollout.service';
import { PlatformUpgradeService } from './services/platform-upgrade.service';
import { PlatformUpgradeExecutorService } from './services/platform-upgrade-executor.service';
import { PlatformUpgradeChecksService } from './services/platform-upgrade-checks.service';
import { PlatformUpgradeRecordsService } from './services/platform-upgrade-records.service';
import { DeclaredImageScheduler } from './schedulers/declared-image.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClusterEntity,
      ApplicationEntity,
      InfrastructureOperationEntity,
      BackupPolicyEntity,
      BackupJobEntity,
    ]),
    BullModule.registerQueue({ name: PLATFORM_UPDATE_QUEUE }),
    ApplicationsModule,
    SharedInfrastructureModule,
    EncryptionModule,
    BackupsModule,
    AuditModule,
  ],
  controllers: [
    PlatformUpdatesController,
    InstallValuesController,
    K3sUpgradeController,
  ],
  providers: [
    PlatformUpdatesService,
    DeclaredImageService,
    DeclaredImageScheduler,
    ManifestRefreshService,
    ManifestMasterService,
    ReleaseManifestService,
    BootstrapFilesService,
    InstallValuesService,
    MasterAccessService,
    InstallStateService,
    InstallSourcesService,
    K3sUpgradeService,
    PlatformUpdateRunnerService,
    PlatformUpdateResumeService,
    PlatformUpdateProcessor,
    ImageRolloutService,
    PlatformUpgradeService,
    PlatformUpgradeExecutorService,
    PlatformUpgradeChecksService,
    PlatformUpgradeRecordsService,
    ApplicationsRepository,
  ],
  exports: [PlatformUpdatesService],
})
export class PlatformUpdatesModule {}
