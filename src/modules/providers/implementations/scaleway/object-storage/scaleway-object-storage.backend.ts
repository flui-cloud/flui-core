import { Injectable } from '@nestjs/common';
import { GenericS3Backend } from '../../../../storage/implementations/generic-s3.backend';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';
import {
  StorageBackendCredentials,
  RcloneRemoteConfig,
} from '../../../../storage/interfaces/backup-storage-backend.interface';

@Injectable()
export class ScalewayObjectStorageBackend extends GenericS3Backend {
  readonly provider: StorageBackendProvider =
    StorageBackendProvider.SCALEWAY_OBJECT_STORAGE;

  toRcloneRemote(creds: StorageBackendCredentials): RcloneRemoteConfig {
    return {
      type: 's3',
      provider: 'Scaleway',
      env: {
        type: 's3',
        provider: 'Scaleway',
        endpoint: creds.endpoint,
        region: creds.region,
        access_key_id: creds.accessKey,
        secret_access_key: creds.secretKey,
      },
    };
  }
}
