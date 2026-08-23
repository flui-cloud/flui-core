import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { AppBuildEntity } from './entities/app-build.entity';
import { AppBuildsRepository } from './repositories/app-builds.repository';
import { AppBuildService } from './services/app-build.service';
import { BuildJobService } from './services/build-job.service';
import { AppBuildProcessor } from './processors/app-build.processor';
import { BuildCacheService } from './services/build-cache.service';
import { BuildCacheInspectionService } from './services/build-cache-inspection.service';
import { BuildAccessService } from './services/build-access.service';
import { BuildCacheSnapshotEntity } from './entities/build-cache-snapshot.entity';
import { AppBuildsController } from './app-builds.controller';
import { BuildNamespaceController } from './controllers/build-namespace.controller';
import { StandaloneBuildsController } from './controllers/standalone-builds.controller';
import { ApplicationsModule } from '../applications/applications.module';
import { IamModule } from '../iam/iam.module';
import { FrameworksModule } from '../frameworks/frameworks.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { InfrastructureOperationsModule } from '../infrastructure/operations/infrastructure-operations.module';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { RepositoryEntity } from '../repositories/entities/repository.entity';
import { RepositoryCredentialEntity } from '../repositories/entities/repository-credential.entity';
import { BuildAgentConfigModule } from './build-agent-config.module';

@Module({
  imports: [
    ConfigModule,
    BuildAgentConfigModule,
    TypeOrmModule.forFeature([
      AppBuildEntity,
      InfrastructureOperationEntity,
      ClusterEntity,
      ApplicationEntity,
      RepositoryEntity,
      RepositoryCredentialEntity,
      BuildCacheSnapshotEntity,
    ]),
    BullModule.registerQueue({
      name: 'app-build',
      settings: {
        stalledInterval: 60000, // check for stalled jobs every 60s
        maxStalledCount: 1, // move to failed after 1 stall (no silent re-queue)
      },
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 25,
      },
    }),
    ApplicationsModule,
    IamModule,
    FrameworksModule,
    SharedInfrastructureModule,
    EncryptionModule,
    ClustersModule,
    InfrastructureOperationsModule,
  ],
  controllers: [
    AppBuildsController,
    BuildNamespaceController,
    StandaloneBuildsController,
  ],
  providers: [
    AppBuildsRepository,
    BuildJobService,
    AppBuildService,
    AppBuildProcessor,
    BuildCacheService,
    BuildCacheInspectionService,
    BuildAccessService,
  ],
  exports: [AppBuildService],
})
export class AppBuildsModule {}
