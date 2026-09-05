import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ApplicationsRepository } from '../applications/repositories/applications.repository';
import { ApplicationsModule } from '../applications/applications.module';
import { PlatformUpdatesController } from './controllers/platform-updates.controller';
import { PlatformUpdatesService } from './services/platform-updates.service';
import { ReleaseManifestService } from './services/release-manifest.service';
import {
  PLATFORM_UPDATE_QUEUE,
  PlatformUpdateRunnerService,
} from './services/platform-update-runner.service';
import { PlatformUpdateResumeService } from './services/platform-update-resume.service';
import { PlatformUpdateProcessor } from './processors/platform-update.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClusterEntity,
      ApplicationEntity,
      InfrastructureOperationEntity,
    ]),
    BullModule.registerQueue({ name: PLATFORM_UPDATE_QUEUE }),
    ApplicationsModule,
  ],
  controllers: [PlatformUpdatesController],
  providers: [
    PlatformUpdatesService,
    ReleaseManifestService,
    PlatformUpdateRunnerService,
    PlatformUpdateResumeService,
    PlatformUpdateProcessor,
    ApplicationsRepository,
  ],
  exports: [PlatformUpdatesService],
})
export class PlatformUpdatesModule {}
