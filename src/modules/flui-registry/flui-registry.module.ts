import { sharedThrottlerStorage } from '../../common/throttling/redis-throttler.storage';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { RegistryTokenController } from './controllers/registry-token.controller';
import { RegistryCredentialEntity } from './entities/registry-credential.entity';
import { RegistrySigningKeyEntity } from './entities/registry-signing-key.entity';
import { RegistryStorageEntity } from './entities/registry-storage.entity';
import { StorageModule } from '../storage/storage.module';
import { RegistryStorageService } from './services/registry-storage.service';
import { RegistryStorageController } from './controllers/registry-storage.controller';
import { ScalewayRegistryStorageProvisioner } from './provisioners/scaleway-registry-storage.provisioner';
import { ApiTokenEntity } from '../access/entities/api-token.entity';
import { ApiTokenRepository } from '../access/repositories/api-token.repository';
import { KeyStorageService } from '../access/services/key-storage.service';
import {
  FLUI_REGISTRY_CONFIG,
  fluiRegistryConfigFrom,
} from './flui-registry.config';
import { FluiRegistryClientService } from './services/flui-registry-client.service';
import { FluiRegistryDeploymentService } from './services/flui-registry-deployment.service';
import { FluiRegistryPublisherService } from './services/flui-registry-publisher.service';
import { RegistryCredentialsService } from './services/registry-credentials.service';
import { RegistrySigningKeyService } from './services/registry-signing-key.service';
import { RegistryTokenService } from './services/registry-token.service';
import { RegistryUsageService } from './services/registry-usage.service';
import { RegistryTrafficService } from './services/registry-traffic.service';
import { RegistryTrafficController } from './controllers/registry-traffic.controller';
import { PrometheusQueryService } from '../observability/services/prometheus-query.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RegistryCredentialEntity,
      RegistrySigningKeyEntity,
      ApplicationEntity,
      ClusterEntity,
      RegistryStorageEntity,
      ApiTokenEntity,
    ]),
    StorageModule,
    EncryptionModule,
    SharedInfrastructureModule,
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      storage: sharedThrottlerStorage(),
    }),
  ],
  controllers: [
    RegistryTokenController,
    RegistryStorageController,
    RegistryTrafficController,
  ],
  providers: [
    {
      provide: FLUI_REGISTRY_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        fluiRegistryConfigFrom((key) => config.get<string>(key)),
    },
    RegistryCredentialsService,
    RegistrySigningKeyService,
    RegistryTokenService,
    FluiRegistryPublisherService,
    FluiRegistryClientService,
    FluiRegistryDeploymentService,
    RegistryStorageService,
    ScalewayRegistryStorageProvisioner,
    RegistryUsageService,
    RegistryTrafficService,
    PrometheusQueryService,
    ApiTokenRepository,
    KeyStorageService,
  ],
  exports: [
    FLUI_REGISTRY_CONFIG,
    FluiRegistryPublisherService,
    FluiRegistryClientService,
    RegistryCredentialsService,
    RegistrySigningKeyService,
  ],
})
export class FluiRegistryModule {}
