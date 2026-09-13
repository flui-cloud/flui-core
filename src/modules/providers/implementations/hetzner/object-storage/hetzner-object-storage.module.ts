import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../../../../storage/storage.module';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';
import {
  OBJECT_STORAGE_PROVISIONER_REGISTRY,
  ObjectStorageProvisionerRegistration,
  multiProvisionerProvider,
} from '../../../../storage/tokens/object-storage-provisioner-registry.token';
import { ApiTokenEntity } from '../../../../access/entities/api-token.entity';
import { ApiTokenRepository } from '../../../../access/repositories/api-token.repository';
import { KeyStorageService } from '../../../../access/services/key-storage.service';
import { HetznerProviderModule } from '../hetzner-provider.module';
import { HetznerObjectStorageConnectionService } from './hetzner-object-storage-connection.service';
import { HetznerObjectStorageConnectionController } from './hetzner-object-storage-connection.controller';
import { HetznerObjectStorageProvisioner } from './hetzner-object-storage.provisioner';
import { HetznerObjectStoragePreset } from './hetzner-object-storage.preset';

/**
 * API-only module che aggiunge il provisioning automatico di Hetzner Object
 * Storage (require ApiTokenRepository → DataSource TypeORM, NON safe per CLI).
 *
 * Importa questo modulo in ProvidersModule (API), NON in CliProvidersModule.
 */
@Module({
  imports: [
    StorageModule,
    HetznerProviderModule,
    TypeOrmModule.forFeature([ApiTokenEntity]),
  ],
  controllers: [HetznerObjectStorageConnectionController],
  providers: [
    ApiTokenRepository,
    KeyStorageService,
    HetznerObjectStorageConnectionService,
    HetznerObjectStorageProvisioner,
    HetznerObjectStoragePreset,

    multiProvisionerProvider({
      provide: OBJECT_STORAGE_PROVISIONER_REGISTRY,
      useFactory: (
        p: HetznerObjectStorageProvisioner,
      ): ObjectStorageProvisionerRegistration => ({
        provider: StorageBackendProvider.HETZNER_OBJECT_STORAGE,
        provisioner: p,
      }),
      inject: [HetznerObjectStorageProvisioner],
      multi: true,
    }),
  ],
  exports: [
    HetznerObjectStorageConnectionService,
    HetznerObjectStorageProvisioner,
    HetznerObjectStoragePreset,
    OBJECT_STORAGE_PROVISIONER_REGISTRY,
  ],
})
export class HetznerObjectStorageModule {}
