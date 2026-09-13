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
import { ScalewayProviderModule } from '../scaleway-provider.module';
import { ScalewayObjectStorageProvisioner } from './scaleway-object-storage.provisioner';
import { ScalewayObjectStoragePreset } from './scaleway-object-storage.preset';

/**
 * API-only module che aggiunge il provisioning automatico di Scaleway Object
 * Storage. Riusa le credenziali Scaleway compute esistenti — quindi richiede
 * ApiTokenRepository (TypeORM DataSource).
 *
 * Importa questo modulo in ProvidersModule (API), NON in CliProvidersModule.
 */
@Module({
  imports: [
    StorageModule,
    ScalewayProviderModule,
    TypeOrmModule.forFeature([ApiTokenEntity]),
  ],
  providers: [
    ApiTokenRepository,
    KeyStorageService,
    ScalewayObjectStorageProvisioner,
    ScalewayObjectStoragePreset,

    multiProvisionerProvider({
      provide: OBJECT_STORAGE_PROVISIONER_REGISTRY,
      useFactory: (
        p: ScalewayObjectStorageProvisioner,
      ): ObjectStorageProvisionerRegistration => ({
        provider: StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
        provisioner: p,
      }),
      inject: [ScalewayObjectStorageProvisioner],
      multi: true,
    }),
  ],
  exports: [
    ScalewayObjectStorageProvisioner,
    ScalewayObjectStoragePreset,
    OBJECT_STORAGE_PROVISIONER_REGISTRY,
  ],
})
export class ScalewayObjectStorageModule {}
