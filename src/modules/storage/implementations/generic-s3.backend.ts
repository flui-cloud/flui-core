import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  IBackupStorageBackend,
  StorageBackendCredentials,
  HealthResult,
  UsageResult,
  ListObjectsResult,
  RcloneRemoteConfig,
} from '../interfaces/backup-storage-backend.interface';
import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';

@Injectable()
export class GenericS3Backend implements IBackupStorageBackend {
  protected readonly logger = new Logger(this.constructor.name);
  readonly provider: StorageBackendProvider = StorageBackendProvider.GENERIC_S3;

  protected buildClient(creds: StorageBackendCredentials): S3Client {
    return new S3Client({
      endpoint: creds.endpoint,
      region: creds.region,
      credentials: {
        accessKeyId: creds.accessKey,
        secretAccessKey: creds.secretKey,
      },
      forcePathStyle: creds.forcePathStyle ?? true,
    });
  }

  async testConnection(
    creds: StorageBackendCredentials,
  ): Promise<HealthResult> {
    const start = Date.now();
    try {
      const client = this.buildClient(creds);
      await client.send(new HeadBucketCommand({ Bucket: creds.bucket }));
      // HeadBucket only proves the bucket exists and creds can read; a backup
      // needs write. Probe a real PUT+DELETE so read-only creds or a
      // deny-PutObject policy fail the test instead of the first backup.
      await this.writeAndDeleteProbe(creds);
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: err?.message ?? String(err),
      };
    }
  }

  async ensureBucket(creds: StorageBackendCredentials): Promise<void> {
    const client = this.buildClient(creds);
    try {
      await client.send(new HeadBucketCommand({ Bucket: creds.bucket }));
      return;
    } catch (err: any) {
      const status = err?.$metadata?.httpStatusCode;
      if (status !== 404 && status !== 403) {
        throw err;
      }
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: creds.bucket }));
    } catch (err: any) {
      if (err?.name === 'BucketAlreadyOwnedByYou') return;
      throw err;
    }
  }

  async getUsage(
    creds: StorageBackendCredentials,
    prefix?: string,
  ): Promise<UsageResult> {
    const client = this.buildClient(creds);
    let bytes = 0;
    let count = 0;
    let token: string | undefined = undefined;
    const fullPrefix = this.joinPrefix(creds.pathPrefix, prefix);
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: creds.bucket,
          Prefix: fullPrefix,
          ContinuationToken: token,
        }),
      );
      for (const o of out.Contents ?? []) {
        bytes += o.Size ?? 0;
        count += 1;
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return { bytes, objectCount: count };
  }

  async listObjects(
    creds: StorageBackendCredentials,
    prefix: string,
    continuationToken?: string,
  ): Promise<ListObjectsResult> {
    const client = this.buildClient(creds);
    const fullPrefix = this.joinPrefix(creds.pathPrefix, prefix);
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: creds.bucket,
        Prefix: fullPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    return {
      keys: (out.Contents ?? []).map((c) => c.Key!).filter(Boolean),
      continuationToken: out.NextContinuationToken,
      hasMore: !!out.IsTruncated,
    };
  }

  async deleteObjects(
    creds: StorageBackendCredentials,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    const client = this.buildClient(creds);
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += 1000) {
      chunks.push(keys.slice(i, i + 1000));
    }
    for (const chunk of chunks) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: creds.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
    }
  }

  /**
   * Removes the bucket with everything in it, uploads left half-way included:
   * a bucket that still holds any of them cannot be deleted.
   */
  async emptyAndDeleteBucket(creds: StorageBackendCredentials): Promise<void> {
    const client = this.buildClient(creds);
    let uploads;
    do {
      uploads = await client.send(
        new ListMultipartUploadsCommand({ Bucket: creds.bucket }),
      );
      for (const upload of uploads.Uploads ?? []) {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: creds.bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
      }
    } while (uploads.IsTruncated);
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: creds.bucket,
          ContinuationToken: token,
        }),
      );
      await this.deleteObjects(
        creds,
        (page.Contents ?? []).map((c) => c.Key!).filter(Boolean),
      );
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await client.send(new DeleteBucketCommand({ Bucket: creds.bucket }));
  }

  async presignDownload(
    creds: StorageBackendCredentials,
    key: string,
    ttlSeconds: number,
  ): Promise<string> {
    const client = this.buildClient(creds);
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: creds.bucket,
        Key: this.joinPrefix(creds.pathPrefix, key),
      }),
      { expiresIn: ttlSeconds },
    );
  }

  toRcloneRemote(creds: StorageBackendCredentials): RcloneRemoteConfig {
    return {
      type: 's3',
      provider: 'Other',
      env: {
        type: 's3',
        provider: 'Other',
        endpoint: creds.endpoint,
        region: creds.region,
        access_key_id: creds.accessKey,
        secret_access_key: creds.secretKey,
        force_path_style: String(creds.forcePathStyle ?? true),
      },
    };
  }

  protected joinPrefix(...parts: (string | undefined)[]): string {
    return parts
      .filter((p): p is string => !!p && p.length > 0)
      .map(trimSlashes)
      .filter((p) => p.length > 0)
      .join('/');
  }

  /**
   * Helper for backends to write a small probe object then delete it,
   * used by health-check write/delete probe step.
   */
  async writeAndDeleteProbe(
    creds: StorageBackendCredentials,
    keySuffix = '.flui-health-probe',
  ): Promise<void> {
    const client = this.buildClient(creds);
    const probeKey = this.joinPrefix(creds.pathPrefix, keySuffix);
    await client.send(
      new PutObjectCommand({
        Bucket: creds.bucket,
        Key: probeKey,
        Body: 'flui-probe',
      }),
    );
    await client.send(
      new DeleteObjectCommand({ Bucket: creds.bucket, Key: probeKey }),
    );
  }

  /**
   * Upload a local file to the bucket under `key` (prefixed by the destination's pathPrefix).
   * ContentLength is read from the file so the SDK can sign a single PUT from a stream without
   * buffering the whole payload in memory. Returns the full object key.
   */
  async uploadFile(
    creds: StorageBackendCredentials,
    key: string,
    filePath: string,
    contentType?: string,
  ): Promise<string> {
    const client = this.buildClient(creds);
    const fullKey = this.joinPrefix(creds.pathPrefix, key);
    const { size } = await stat(filePath);
    await client.send(
      new PutObjectCommand({
        Bucket: creds.bucket,
        Key: fullKey,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
    return fullKey;
  }
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}
