import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { SharedInfrastructureModule } from '../shared/shared-infrastructure.module';
import { EncryptionModule } from '../../shared/encryption/encryption.module';
import { EgressPolicyService } from './egress-policy.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClusterEntity, ApplicationEntity]),
    SharedInfrastructureModule,
    EncryptionModule,
  ],
  providers: [EgressPolicyService],
  exports: [EgressPolicyService],
})
export class EgressModule {}
