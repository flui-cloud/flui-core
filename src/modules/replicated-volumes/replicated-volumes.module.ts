import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ClusterHaModule } from '../cluster-ha/cluster-ha.module';
import { PiraeusInstallerService } from './services/piraeus-installer.service';
import { ReplicatedPoolPreparer } from './services/replicated-pool.preparer';
import { ReplicatedVolumesService } from './services/replicated-volumes.service';
import { ReplicatedVolumesProcessor } from './processors/replicated-volumes.processor';
import { ReplicatedVolumesController } from './controllers/replicated-volumes.controller';
import { REPLICATED_VOLUMES_QUEUE } from './replicated-volumes.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClusterEntity, InfrastructureOperationEntity]),
    BullModule.registerQueue({ name: REPLICATED_VOLUMES_QUEUE }),
    SharedInfrastructureModule,
    EncryptionModule,
    ClusterHaModule,
  ],
  controllers: [ReplicatedVolumesController],
  providers: [
    PiraeusInstallerService,
    ReplicatedPoolPreparer,
    ReplicatedVolumesService,
    ReplicatedVolumesProcessor,
  ],
  exports: [ReplicatedVolumesService, ReplicatedPoolPreparer],
})
export class ReplicatedVolumesModule {}
