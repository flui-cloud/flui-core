import { PlatformBackupDownloadService } from './services/platform-backup-download.service';
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
import { BackupActivityService } from './services/backup-activity.service';
import { RestoreJobsService } from './services/restore-jobs.service';
import { TemplateRendererService } from './services/template-renderer.service';
import { EtcdSnapshotService } from './services/etcd-snapshot.service';
import { BackupAlertService } from './services/backup-alert.service';
import { AlertEventEntity } from '../observability/entities/alert-event.entity';

import { ReplicateBackupProcessor } from './processors/replicate-backup.processor';
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
import { PgLegacyRepoRetirer } from './services/pg-legacy-repo.retirer';
import { PlaintextRetirementService } from './services/plaintext-retirement.service';
import { DestinationPlacementValidator } from './services/destination-placement.validator';
import { DbPitrService } from './services/db-pitr.service';
import { PlatformKeyBundleService } from './services/platform-key-bundle.service';
import { PlatformBackupService } from './services/platform-backup.service';
import { RunPlatformBackupProcessor } from './processors/run-platform-backup.processor';
import { MasterHeartbeatScheduler } from './schedulers/master-heartbeat.scheduler';
import { InstallationHealthService } from './services/installation-health.service';
import { PrometheusQueryService } from '../observability/services/prometheus-query.service';

import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { QuickSetupService } from './services/quick-setup.service';
import { QuickSetupProcessor } from './processors/quick-setup.processor';
import { BillingEstimatorService } from './services/billing-estimator.service';
import { BackupPolicyScheduler } from './schedulers/backup-policy.scheduler';
import { BackupRetentionSweeper } from './schedulers/backup-retention.sweeper';
import { RunVolumeCopyProcessor } from './processors/run-volume-copy.processor';
import { MariadbPitrService } from './services/mariadb-pitr.service';
import {
  MariadbDumpService,
  PostgresDumpService,
} from './services/logical-dump.service';
import { ContinuousBackupEngineRegistry } from './services/continuous-backup-engine.registry';
import { RebuildDataRestorer } from './services/rebuild-data-restorer.service';
import { DeclaredEngineResolver } from './services/declared-engine.resolver';
import { BackupStatusService } from './services/backup-status.service';

import { BACKUP_QUEUE } from './backups.constants';
import { AppProtectionController } from './controllers/app-protection.controller';
import { AppProtectionService } from './services/app-protection.service';
import { AppBackupDecisionService } from './services/app-backup-decision.service';
import { AppCoverageService } from './services/app-coverage.service';
import { BackupClusterProtectionEntity } from './entities/backup-cluster-protection.entity';
import { ClusterDecisionsService } from './services/cluster-decisions.service';
import { ClusterProtectionService } from './services/cluster-protection.service';
import { ClusterProtectionProcessor } from './processors/cluster-protection.processor';
import { ClusterProtectionScheduler } from './schedulers/cluster-protection.scheduler';
import { ClusterProtectionController } from './controllers/cluster-protection.controller';
import { PreDeployBackupService } from './services/pre-deploy-backup.service';
import { PreDeployBackupProcessor } from './processors/pre-deploy-backup.processor';
import { KopiaReplicationService } from './services/kopia-replication.service';
import { AppVolumeBackupProcessor } from './processors/app-volume-backup.processor';
import { VeleroUninstallService } from './services/velero-uninstall.service';
import { UninstallVeleroProcessor } from './processors/uninstall-velero.processor';
import { VeleroUninstallController } from './controllers/velero-uninstall.controller';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      AlertEventEntity,
      BackupDestinationEntity,
      BackupPolicyEntity,
      BackupPolicyDestinationEntity,
      BackupJobEntity,
      BackupArtifactEntity,
      BackupArtifactLocationEntity,
      BackupClusterProtectionEntity,
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
    forwardRef(() => ClustersModule),
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
    AppProtectionController,
    BackupPoliciesController,
    BackupJobsController,
    BackupArtifactsController,
    RestoreJobsController,
    QuickSetupController,
    ClusterProtectionController,
    VeleroUninstallController,
    BillingEstimatorController,
    BackupStatusController,
  ],
  providers: [
    PlatformBackupDownloadService,
    BackupDestinationRepository,
    BackupPolicyRepository,
    BackupJobRepository,
    BackupArtifactRepository,
    RestoreJobRepository,
    BackupDestinationsService,
    BackupPoliciesService,
    BackupJobsService,
    BackupActivityService,
    RestoreJobsService,
    TemplateRendererService,
    EtcdSnapshotService,
    BackupAlertService,
    ReplicateBackupProcessor,
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
    PostgresDumpService,
    MariadbDumpService,
    ContinuousBackupEngineRegistry,
    RebuildDataRestorer,
    DeclaredEngineResolver,
    BackupStatusService,
    PgBackrestService,
    PgLegacyRepoRetirer,
    PlaintextRetirementService,
    DestinationPlacementValidator,
    DbPitrService,
    AppProtectionService,
    AppBackupDecisionService,
    AppCoverageService,
    PlatformKeyBundleService,
    PlatformBackupService,
    RunPlatformBackupProcessor,
    MasterHeartbeatScheduler,
    InstallationHealthService,
    PrometheusQueryService,
    ClusterDecisionsService,
    ClusterProtectionService,
    ClusterProtectionProcessor,
    ClusterProtectionScheduler,
    PreDeployBackupService,
    PreDeployBackupProcessor,
    KopiaReplicationService,
    AppVolumeBackupProcessor,
    VeleroUninstallService,
    UninstallVeleroProcessor,
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
    RebuildDataRestorer,
    AppCoverageService,
  ],
})
export class BackupsModule {}
