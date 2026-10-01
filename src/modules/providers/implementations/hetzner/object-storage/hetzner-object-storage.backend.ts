import { Injectable } from '@nestjs/common';
import { GenericS3Backend } from '../../../../storage/implementations/generic-s3.backend';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';

@Injectable()
export class HetznerObjectStorageBackend extends GenericS3Backend {
  readonly provider: StorageBackendProvider =
    StorageBackendProvider.HETZNER_OBJECT_STORAGE;
}
