import { Module } from '@nestjs/common';
import { GenericS3Backend } from './implementations/generic-s3.backend';
import { StorageBackendFactory } from './factories/storage-backend.factory';
import {
  GenericS3ObjectStoragePreset,
  MinioObjectStoragePreset,
} from './presets/self-hosted-object-storage.presets';

@Module({
  providers: [
    GenericS3Backend,
    StorageBackendFactory,
    MinioObjectStoragePreset,
    GenericS3ObjectStoragePreset,
  ],
  exports: [
    GenericS3Backend,
    StorageBackendFactory,
    MinioObjectStoragePreset,
    GenericS3ObjectStoragePreset,
  ],
})
export class StorageModule {}
