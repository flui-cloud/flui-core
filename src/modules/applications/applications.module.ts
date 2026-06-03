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
import { RepositoryCredentialEntity } from '../repositories/entities/repository-credential.entity';
import { AppBuildEntity } from '../app-builds/entities/app-build.entity';
import { CatalogInstallEntity } from '../catalog/entities/catalog-install.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { BuildAgentConfigModule } from '../app-builds/build-agent-config.module';
import { ImageRegistryModule } from '../image-registry/image-registry.module';
import { ApplicationsRepository } from './repositories/applications.repository';
import { AppRevisionsRepository } from './repositories/app-revisions.repository';
import { AppResourcesRepository } from './repositories/app-resources.repository';
import { ApplicationService } from './services/application.service';
import { ApplicationGroupingService } from './services/application-grouping.service';
import { ApplicationManifestGeneratorService } from './services/application-manifest-generator.service';
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
import { VolumeBackupsService } from './services/volume-backups.service';
import { DedicatedPlacementService } from './services/dedicated-placement.service';
import { ApplicationDeployProcessor } from './processors/application-deploy.processor';
import {
  ApplicationBuildWatchProcessor,
  BUILD_WATCH_QUEUE,
} from './processors/application-build-watch.processor';
import {
  GhcrSecretRefreshProcessor,
  GHCR_SECRET_REFRESH_QUEUE,
} from './processors/ghcr-secret-refresh.processor';
import { ApplicationsController } from './controllers/applications.controller';
import { VariablesController } from './controllers/variables.controller';
import { AppManagementController } from './controllers/app-management.controller';
import { ApplicationEventsGateway } from './gateway/application-events.gateway';
import { AppOperationRunner } from './services/app-operation-runner.service';
import { ScalingModule } from '../scaling/scaling.module';
import { DnsModule } from '../dns/dns.module';
import { WsAuthModule } from '../auth/ws-auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      ApplicationEntity,
      AppRevisionEntity,
      AppResourceEntity,
      InfrastructureOperationEntity,
      ClusterEntity,
      RepositoryCredentialEntity,
      AppBuildEntity,
      // Registered here for cascade cleanup only: when an Application owned
      // by a catalog install is deleted, the deploy processor also marks the
      // parent CatalogInstall row UNINSTALLED to keep the two in sync.
      // We bind the entity at TypeORM level (not via CatalogModule) to avoid
      // a circular module dependency.
      CatalogInstallEntity,
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
    WsAuthModule,
    StorageModule,
  ],
  controllers: [
    ApplicationsController,
    VariablesController,
    AppManagementController,
  ],
  providers: [
    // Repositories
    ApplicationsRepository,
    AppRevisionsRepository,
    AppResourcesRepository,

    // Services
    ApplicationService,
    ApplicationGroupingService,
    ApplicationManifestGeneratorService,
    ApplicationDeployService,
    DeployConfigService,
    ApplicationReconciliationService,
    SystemAppCatalogService,
    AppConfigService,
    AppManagementService,
    ApplicationWorkflowService,
    ApplicationBuildWatcherService,
    ApplicationReleaseService,
    GhcrSecretRefreshService,
    ApplicationVersionsService,
    ApplicationSourceDeployService,
    VolumeSnapshotsService,
    VolumeBackupsService,
    DedicatedPlacementService,
    ApplicationEventsGateway,
    AppOperationRunner,

    // Processors
    ApplicationDeployProcessor,
    ApplicationBuildWatchProcessor,
    GhcrSecretRefreshProcessor,
  ],
  exports: [
    ApplicationService,
    ApplicationDeployService,
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
  ],
})
export class ApplicationsModule {}
