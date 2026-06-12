import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';
import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ProvidersModule } from '../providers/providers.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProviderConfigurationEntity } from '../management/entities/provider-configuration.entity';
import { ProviderConfigurationRepository } from '../management/repositories/provider-configuration.repository';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    AccessModule,
    ProvidersModule,
    TypeOrmModule.forFeature([ProviderConfigurationEntity, ClusterEntity]),
  ],
  controllers: [InstancesController],
  providers: [InstancesService, ProviderConfigurationRepository],
  exports: [InstancesService],
})
export class InstancesModule {}
