import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { AccessModule } from '../access/access.module';
import { AdoptionController } from './adoption.controller';
import { AdoptionTokenService } from './services/adoption-token.service';
import { AdoptionTokenGuard } from './guards/adoption-token.guard';
import { NodeEnrolmentService } from './services/node-enrolment.service';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ClusterEntity]),
    ClustersModule,
    AccessModule,
    SharedInfrastructureModule,
    EncryptionModule,
  ],
  controllers: [AdoptionController],
  providers: [AdoptionTokenService, AdoptionTokenGuard, NodeEnrolmentService],
  exports: [AdoptionTokenService],
})
export class AdoptionModule {}
