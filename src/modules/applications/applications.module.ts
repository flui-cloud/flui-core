import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ImagesModule } from '../images/images.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { ApplicationEntity } from './entities/application.entity';
import { AppRevisionEntity } from './entities/app-revision.entity';
import { AppResourceEntity } from './entities/app-resource.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ProjectEntity } from '../projects/entities/project.entity';
import { IamModule } from '../iam/iam.module';
import { ApplicationAccessService } from './services/application-access.service';
import { AppAccessGuard } from './guards/app-access.guard';
import { RepositoryCredentialEntity } from '../repositories/entities/repository-credential.entity';
import { AppBuildEntity } from '../app-builds/entities/app-build.entity';
import { CatalogInstallEntity } from '../catalog/entities/catalog-install.entity';
import { SandboxTenantEntity } from '../sandbox/entities/sandbox-tenant.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { BuildAgentConfigModule } from '../app-builds/build-agent-config.module';
import { ImageRegistryModule } from '../image-registry/image-registry.module';
import { ApplicationsRepository } from './repositories/applications.repository';
import { AppRevisionsRepository } from './repositories/app-revisions.repository';
import { AppResourcesRepository } from './repositories/app-resources.repository';
import { ApplicationService } from './services/application.service';
import { ApplicationGroupingService } from './services/application-grouping.service';
import { ApplicationManifestGeneratorService } from './services/application-manifest-generator.service';
import { ApplicationMaterializerService } from './services/application-materializer.service';
import { ApplicationDeployService } from './services/application-deploy.service';
import { DeployConfigService } from './services/deploy-config.service';
import { ApplicationReconciliationService } from './services/application-reconciliation.service';
import { SystemAppCatalogService } from './services/system-app-catalog.service';
import { AppConfigService } from './services/app-config.service';
import { AppManagementService } from './services/app-management.service';
import { ApplicationWorkflowService } from './services/application-workflow.service';
import { ApplicationBuildWatcherService } from './services/application-build-watcher.service';
import { ApplicationReleaseService } from './services/application-release.service';
import { GhcrSecretRefreshService } from './services/ghcr-secret-refresh.service';
import { ApplicationVersionsService } from './services/application-versions.service';
import { ApplicationSourceDeployService } from './services/application-source-deploy.service';
import { VolumeSnapshotsService } from './services/volume-snapshots.service';
import { VolumeCopyLedgerService } from './services/volume-copy-ledger.service';
import { VolumeCopyPreflightService } from './services/volume-copy-preflight.service';
import { VolumePauseLeaseService } from './services/volume-pause-lease.service';
import { VolumePauseSweeperService } from './schedulers/volume-pause-sweeper.service';
import { BackupJobEntity } from '../backups/entities/backup-job.entity';
import { BackupDestinationEntity } from '../backups/entities/backup-destination.entity';
import { BackupArtifactEntity } from '../backups/entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../backups/entities/backup-artifact-location.entity';
import { SnapshotStorageCapabilityService } from './services/snapshot-storage-capability.service';
import { VolumeBackupsService } from './services/volume-backups.service';
import { DedicatedPlacementService } from './services/dedicated-placement.service';
import { ApplicationDeployProcessor } from './processors/application-deploy.processor';
import { ApplicationTeardownService } from './processors/application-teardown.service';
import { ApplicationVolumeClaimsService } from './services/application-volume-claims.service';
import {
  ApplicationBuildWatchProcessor,
  BUILD_WATCH_QUEUE,
} from './processors/application-build-watch.processor';
import {
  GhcrSecretRefreshProcessor,
  GHCR_SECRET_REFRESH_QUEUE,
} from './processors/ghcr-secret-refresh.processor';
import { ApplicationsController } from './controllers/applications.controller';
import { ApplicationReleasesController } from './controllers/application-releases.controller';
import { ApplicationSnapshotsController } from './controllers/application-snapshots.controller';
import { ShowcaseController } from './controllers/showcase.controller';
import { ShowcaseService } from './services/showcase.service';
import { VariablesController } from './controllers/variables.controller';
import { ScheduledJobsController } from './controllers/scheduled-jobs.controller';
import { ScheduledJobsService } from './services/scheduled-jobs.service';
import {
  ClusterGatewayController,
  GatewayController,
} from './controllers/gateway.controller';
import { GatewayService } from './services/gateway.service';
import { AppManagementController } from './controllers/app-management.controller';
import { ApplicationEventsGateway } from './gateway/application-events.gateway';
import { AppOperationRunner } from './services/app-operation-runner.service';
import { ScalingModule } from '../scaling/scaling.module';
import { DnsModule } from '../dns/dns.module';
import { WsAuthModule } from '../auth/ws-auth.module';
import { StorageModule } from '../storage/storage.module';
import { VolumeExportService } from '../providers/services/volume-export.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      // The volume-copy ledger writes backup rows from this module; registering
      // the entities here keeps that a repository dependency rather than a
      // module one, so applications and backups stay independent.
      BackupDestinationEntity,
      BackupJobEntity,
      BackupArtifactEntity,
      BackupArtifactLocationEntity,
      ApplicationEntity,
      AppRevisionEntity,
      AppResourceEntity,
      InfrastructureOperationEntity,
      ClusterEntity,
      ProjectEntity,
      RepositoryCredentialEntity,
      AppBuildEntity,
      // Registered here for cascade cleanup only: when an Application owned
      // by a catalog install is deleted, the deploy processor also marks the
      // parent CatalogInstall row UNINSTALLED to keep the two in sync.
      // We bind the entity at TypeORM level (not via CatalogModule) to avoid
      // a circular module dependency.
      CatalogInstallEntity,
      // Bound at TypeORM level for the same reason: ApplicationAccessService
      // pins sandbox guests to their tenancy cluster.
      SandboxTenantEntity,
    ]),
    BullModule.registerQueue({ name: 'application-deploy' }),
    BullModule.registerQueue({ name: 'app-build' }),
    BullModule.registerQueue({ name: BUILD_WATCH_QUEUE }),
    BullModule.registerQueue({ name: GHCR_SECRET_REFRESH_QUEUE }),
    BullModule.registerQueue({ name: 'backup' }),
    SharedInfrastructureModule,
    EncryptionModule,
    ImagesModule,
    RepositoriesModule,
    BuildAgentConfigModule,
    forwardRef(() => ImageRegistryModule),
    forwardRef(() => ScalingModule),
    forwardRef(() => DnsModule),
    forwardRef(() => ClustersModule),
    WsAuthModule,
    StorageModule,
    IamModule,
  ],
  controllers: [
    ApplicationsController,
    ApplicationReleasesController,
    ApplicationSnapshotsController,
    VariablesController,
    AppManagementController,
    ScheduledJobsController,
    GatewayController,
    ClusterGatewayController,
    ShowcaseController,
  ],
  providers: [
    ShowcaseService,
    // IAM enforcement (resource-aware app access)
    ApplicationAccessService,
    AppAccessGuard,

    // Repositories
    ApplicationsRepository,
    AppRevisionsRepository,
    AppResourcesRepository,

    // Services
    ApplicationService,
    ApplicationGroupingService,
    ApplicationManifestGeneratorService,
    ApplicationMaterializerService,
    ApplicationDeployService,
    DeployConfigService,
    ApplicationReconciliationService,
    SystemAppCatalogService,
    AppConfigService,
    ScheduledJobsService,
    GatewayService,
    AppManagementService,
    ApplicationWorkflowService,
    ApplicationBuildWatcherService,
    ApplicationReleaseService,
    GhcrSecretRefreshService,
    ApplicationVersionsService,
    ApplicationSourceDeployService,
    VolumeSnapshotsService,
    VolumeCopyLedgerService,
    VolumeCopyPreflightService,
    VolumePauseLeaseService,
    VolumePauseSweeperService,
    SnapshotStorageCapabilityService,
    VolumeExportService,
    VolumeBackupsService,
    DedicatedPlacementService,
    ApplicationEventsGateway,
    AppOperationRunner,

    // Processors
    ApplicationDeployProcessor,
    ApplicationTeardownService,
    ApplicationVolumeClaimsService,
    ApplicationBuildWatchProcessor,
    GhcrSecretRefreshProcessor,
  ],
  exports: [
    // Re-exported so the guards that hang off this module's repositories can
    // ask IAM the same question the rest of the product asks it. The alternative
    // was a second, weaker authority derived beside the engine — which is
    // exactly the divergence that let a console answer differently from
    // `GET /applications/:id` about the same id.
    IamModule,
    ApplicationAccessService,
    ApplicationVolumeClaimsService,
    // The scheduled volume-copy engine runs this rather than reimplementing
    // the copy primitive beside it, so the ad-hoc and scheduled paths cannot
    // drift on the consistency gate they both go through.
    VolumeBackupsService,
    // Exported so controllers outside this module can mount it — the two
    // `applications/:applicationId/**` controllers in ScalingModule do.
    AppAccessGuard,
    AppConfigService,
    ApplicationService,
    ApplicationDeployService,
    ApplicationMaterializerService,
    ApplicationSourceDeployService,
    ApplicationReconciliationService,
    ApplicationsRepository,
    AppRevisionsRepository,
    AppResourcesRepository,
    ApplicationEventsGateway,
    AppManagementService,
    ApplicationWorkflowService,
    ApplicationBuildWatcherService,
    ApplicationReleaseService,
    SystemAppCatalogService,
    DeployConfigService,
    DedicatedPlacementService,
    ScheduledJobsService,
    GatewayService,
  ],
})
export class ApplicationsModule {}
