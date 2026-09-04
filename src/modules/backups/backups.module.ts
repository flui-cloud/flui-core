import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ApplicationsModule } from '../applications/applications.module';
import { UserEntity } from '../auth/entities/user.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { StorageModule } from '../storage/storage.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogInstallEntity } from '../catalog/entities/catalog-install.entity';
import { ControlClusterModule } from '../infrastructure/control-cluster/control-cluster.module';

import { BackupDestinationEntity } from './entities/backup-destination.entity';
import { BackupPolicyEntity } from './entities/backup-policy.entity';
import { BackupPolicyDestinationEntity } from './entities/backup-policy-destination.entity';
import { BackupJobEntity } from './entities/backup-job.entity';
import { BackupArtifactEntity } from './entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from './entities/backup-artifact-location.entity';
import { RestoreJobEntity } from './entities/restore-job.entity';

import { BackupDestinationRepository } from './repositories/backup-destination.repository';
import { BackupPolicyRepository } from './repositories/backup-policy.repository';
import { BackupJobRepository } from './repositories/backup-job.repository';
import { BackupArtifactRepository } from './repositories/backup-artifact.repository';
import { RestoreJobRepository } from './repositories/restore-job.repository';

import { BackupDestinationsService } from './services/backup-destinations.service';
import { BackupPoliciesService } from './services/backup-policies.service';
import { BackupJobsService } from './services/backup-jobs.service';
import { RestoreJobsService } from './services/restore-jobs.service';
import { VeleroInstallerService } from './services/velero-installer.service';
import { VeleroClientService } from './services/velero-client.service';
import { TemplateRendererService } from './services/template-renderer.service';
import { EtcdSnapshotService } from './services/etcd-snapshot.service';

import { InstallVeleroProcessor } from './processors/install-velero.processor';
import {
  RunBackupJobProcessor,
  PreDeployTriggerProcessor,
} from './processors/run-backup-job.processor';
import { ReplicateBackupProcessor } from './processors/replicate-backup.processor';
import { RunRestoreJobProcessor } from './processors/run-restore-job.processor';
import { RunDbBackupProcessor } from './processors/run-db-backup.processor';
import { RunDbRestoreProcessor } from './processors/run-db-restore.processor';
import { HealthCheckProcessor } from './processors/health-check.processor';

import { BackupDestinationsController } from './controllers/backup-destinations.controller';
import { BackupPoliciesController } from './controllers/backup-policies.controller';
import { BackupJobsController } from './controllers/backup-jobs.controller';
import { BackupArtifactsController } from './controllers/backup-artifacts.controller';
import { RestoreJobsController } from './controllers/restore-jobs.controller';
import { QuickSetupController } from './controllers/quick-setup.controller';
import { BillingEstimatorController } from './controllers/billing-estimator.controller';
import { BackupStatusController } from './controllers/backup-status.controller';
import { PgBackrestService } from './services/pgbackrest.service';
import { DestinationPlacementValidator } from './services/destination-placement.validator';
import { DbPitrService } from './services/db-pitr.service';
import { PlatformKeyBundleService } from './services/platform-key-bundle.service';
import { PlatformBackupService } from './services/platform-backup.service';
import { RunPlatformBackupProcessor } from './processors/run-platform-backup.processor';
import { MasterHeartbeatScheduler } from './schedulers/master-heartbeat.scheduler';

import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { QuickSetupService } from './services/quick-setup.service';
import { QuickSetupProcessor } from './processors/quick-setup.processor';
import { BillingEstimatorService } from './services/billing-estimator.service';
import { BackupPolicyScheduler } from './schedulers/backup-policy.scheduler';
import { BackupRetentionSweeper } from './schedulers/backup-retention.sweeper';
import { RunVolumeCopyProcessor } from './processors/run-volume-copy.processor';
import { MariadbPitrService } from './services/mariadb-pitr.service';
import { ContinuousBackupEngineRegistry } from './services/continuous-backup-engine.registry';
import { DeclaredEngineResolver } from './services/declared-engine.resolver';
import { BackupStatusService } from './services/backup-status.service';

import { BACKUP_QUEUE } from './backups.constants';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      BackupDestinationEntity,
      BackupPolicyEntity,
      BackupPolicyDestinationEntity,
      BackupJobEntity,
      BackupArtifactEntity,
      BackupArtifactLocationEntity,
      RestoreJobEntity,
      ClusterEntity,
      ClusterNodeEntity,
      InfrastructureOperationEntity,
      ApplicationEntity,
      CatalogInstallEntity,
      UserEntity,
    ]),
    BullModule.registerQueue({ name: BACKUP_QUEUE }),
    SharedInfrastructureModule,
    ClustersModule,
    EncryptionModule,
    StorageModule,
    CatalogModule,
    ControlClusterModule,
    // The scheduled volume-copy engine drives the same copy service the ad-hoc
    // command uses, rather than reimplementing the primitive next to it. One
    // way only — applications reaches backups through entities, not the module
    // — and behind a forwardRef so the direction cannot become a cycle later.
    forwardRef(() => ApplicationsModule),
  ],
  controllers: [
    BackupDestinationsController,
    BackupPoliciesController,
    BackupJobsController,
    BackupArtifactsController,
    RestoreJobsController,
    QuickSetupController,
    BillingEstimatorController,
    BackupStatusController,
  ],
  providers: [
    BackupDestinationRepository,
    BackupPolicyRepository,
    BackupJobRepository,
    BackupArtifactRepository,
    RestoreJobRepository,
    BackupDestinationsService,
    BackupPoliciesService,
    BackupJobsService,
    RestoreJobsService,
    VeleroInstallerService,
    VeleroClientService,
    TemplateRendererService,
    EtcdSnapshotService,
    InstallVeleroProcessor,
    RunBackupJobProcessor,
    PreDeployTriggerProcessor,
    ReplicateBackupProcessor,
    RunRestoreJobProcessor,
    RunDbBackupProcessor,
    RunDbRestoreProcessor,
    HealthCheckProcessor,
    QuickSetupService,
    QuickSetupProcessor,
    BillingEstimatorService,
    BackupPolicyScheduler,
    BackupRetentionSweeper,
    RunVolumeCopyProcessor,
    MariadbPitrService,
    ContinuousBackupEngineRegistry,
    DeclaredEngineResolver,
    BackupStatusService,
    PgBackrestService,
    DestinationPlacementValidator,
    DbPitrService,
    PlatformKeyBundleService,
    PlatformBackupService,
    RunPlatformBackupProcessor,
    MasterHeartbeatScheduler,
  ],
  exports: [
    BackupDestinationsService,
    BackupPoliciesService,
    BackupJobsService,
    RestoreJobsService,
    QuickSetupService,
    BillingEstimatorService,
    BackupStatusService,
    DbPitrService,
  ],
})
export class BackupsModule {}
