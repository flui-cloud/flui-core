import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ClusterHaService } from './services/cluster-ha.service';
import { EtcdLeaderPlacementService } from './services/etcd-leader-placement.service';
import { SiteRoundTripService } from './services/site-round-trip.service';
import { ClusterHaSweepService } from './services/cluster-ha-sweep.service';
import { ClusterHaSweepScheduler } from './schedulers/cluster-ha-sweep.scheduler';
import { ClusterHaController } from './controllers/cluster-ha.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClusterEntity]),
    SharedInfrastructureModule,
    EncryptionModule,
  ],
  controllers: [ClusterHaController],
  providers: [
    ClusterHaService,
    EtcdLeaderPlacementService,
    SiteRoundTripService,
    ClusterHaSweepService,
    ClusterHaSweepScheduler,
  ],
  exports: [ClusterHaService],
})
export class ClusterHaModule {}
