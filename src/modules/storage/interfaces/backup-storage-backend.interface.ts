import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';

export interface StorageBackendCredentials {
  provider: StorageBackendProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle?: boolean;
  pathPrefix?: string;
}

export interface HealthResult {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface UsageResult {
  bytes: number;
  objectCount: number;
}

export interface ListObjectsResult {
  keys: string[];
  continuationToken?: string;
  hasMore: boolean;
}

export interface VeleroBSLConfig {
  provider: 'aws';
  config: Record<string, string>;
  credentialsKey: string;
  bucket: string;
  prefix?: string;
}

export interface RcloneRemoteConfig {
  type: 's3';
  provider: string;
  env: Record<string, string>;
}

export interface IBackupStorageBackend {
  readonly provider: StorageBackendProvider;

  testConnection(creds: StorageBackendCredentials): Promise<HealthResult>;

  ensureBucket(creds: StorageBackendCredentials): Promise<void>;

  getUsage(
    creds: StorageBackendCredentials,
    prefix?: string,
  ): Promise<UsageResult>;

  listObjects(
    creds: StorageBackendCredentials,
    prefix: string,
    continuationToken?: string,
  ): Promise<ListObjectsResult>;

  deleteObjects(
    creds: StorageBackendCredentials,
    keys: string[],
  ): Promise<void>;

  presignDownload(
    creds: StorageBackendCredentials,
    key: string,
    ttlSeconds: number,
  ): Promise<string>;

  /** Upload a local file under `key` (prefixed by pathPrefix); returns the full object key. */
  uploadFile(
    creds: StorageBackendCredentials,
    key: string,
    filePath: string,
    contentType?: string,
  ): Promise<string>;

  toVeleroBSL(creds: StorageBackendCredentials): VeleroBSLConfig;

  toRcloneRemote(creds: StorageBackendCredentials): RcloneRemoteConfig;
}
