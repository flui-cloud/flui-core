import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import axios, { AxiosInstance } from 'axios';
import {
  S3Client,
  ListBucketsCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import {
  BucketPolicy,
  ObjectStoreAdminConnectParams,
  ObjectStoreAdminConnection,
  ObjectStoreConnectParams,
  ObjectStoreConnection,
  ObjectStoreEngine,
  ObjectStoreEngineAdapter,
  S3Bucket,
  S3Listing,
  S3ObjectBody,
  S3ObjectMeta,
} from './object-store-engine';

/** Max keys per DeleteObjects call (S3 hard limit). */
const DELETE_BATCH = 1000;

class GarageS3Connection implements ObjectStoreConnection {
  constructor(private readonly client: S3Client) {}

  async listBuckets(): Promise<S3Bucket[]> {
    const out = await this.client.send(new ListBucketsCommand({}));
    return (out.Buckets ?? []).map((b) => ({
      name: b.Name ?? '',
      creationDate: b.CreationDate?.toISOString(),
    }));
  }

  async createBucket(bucket: string): Promise<void> {
    await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  async deleteBucket(bucket: string): Promise<void> {
    await this.client.send(new DeleteBucketCommand({ Bucket: bucket }));
  }

  async listObjects(
    bucket: string,
    opts: {
      prefix?: string;
      delimiter?: string;
      continuationToken?: string;
      maxKeys?: number;
    },
  ): Promise<S3Listing> {
    const out = await this.client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: opts.prefix || undefined,
        Delimiter: opts.delimiter || undefined,
        ContinuationToken: opts.continuationToken || undefined,
        MaxKeys: opts.maxKeys,
      }),
    );
    const prefix = opts.prefix ?? '';
    return {
      prefix,
      delimiter: opts.delimiter ?? '',
      prefixes: (out.CommonPrefixes ?? [])
        .map((p) => p.Prefix ?? '')
        .filter(Boolean),
      // Drop the folder marker key (== prefix) so an empty "folder" isn't listed as a 0-byte object.
      objects: (out.Contents ?? [])
        .filter((o) => (o.Key ?? '') !== prefix)
        .map((o) => ({
          key: o.Key ?? '',
          size: o.Size ?? 0,
          lastModified: o.LastModified?.toISOString(),
          etag: o.ETag,
        })),
      isTruncated: out.IsTruncated ?? false,
      continuationToken: out.NextContinuationToken,
      keyCount: out.KeyCount ?? 0,
    };
  }

  async headObject(bucket: string, key: string): Promise<S3ObjectMeta> {
    const out = await this.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      key,
      size: out.ContentLength ?? 0,
      contentType: out.ContentType,
      lastModified: out.LastModified?.toISOString(),
      etag: out.ETag,
      metadata: out.Metadata,
    };
  }

  async getObject(bucket: string, key: string): Promise<S3ObjectBody> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      // In Node the SDK returns a Readable for Body.
      stream: out.Body as Readable,
      contentType: out.ContentType,
      contentLength: out.ContentLength,
      etag: out.ETag,
    };
  }

  async putObject(
    bucket: string,
    key: string,
    body: Readable | Buffer,
    opts: { contentType?: string; contentLength?: number },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ContentLength: opts.contentLength,
      }),
    );
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

/**
 * S3-wire adapter (Garage). Connects to the in-cluster S3 API through the
 * ephemeral port-forward tunnel using path-style addressing (Garage/MinIO need
 * it — no per-bucket virtual hosts behind a loopback endpoint).
 */
interface GarageBucketListItem {
  id: string;
  globalAliases?: string[];
}
interface GarageBucketInfo {
  id: string;
  websiteAccess?: boolean;
}

/**
 * Garage admin-API session (v1) for bucket policy. "public" maps to Garage's
 * website-access flag (anonymous read via the web endpoint). Buckets are
 * addressed by id, so each op resolves the id from the global alias first.
 */
class GarageAdminConnection implements ObjectStoreAdminConnection {
  constructor(private readonly http: AxiosInstance) {}

  private async bucketIdFor(bucket: string): Promise<string> {
    const { data } =
      await this.http.get<GarageBucketListItem[]>('/v1/bucket?list');
    const match = data.find((b) => (b.globalAliases ?? []).includes(bucket));
    if (!match) throw new Error(`Bucket "${bucket}" not found`);
    return match.id;
  }

  async getBucketPolicy(bucket: string): Promise<BucketPolicy> {
    const id = await this.bucketIdFor(bucket);
    const { data } = await this.http.get<GarageBucketInfo>(
      `/v1/bucket?id=${encodeURIComponent(id)}`,
    );
    return { public: data.websiteAccess === true };
  }

  async setBucketPolicy(
    bucket: string,
    isPublic: boolean,
  ): Promise<BucketPolicy> {
    const id = await this.bucketIdFor(bucket);
    const websiteAccess = isPublic
      ? {
          enabled: true,
          indexDocument: 'index.html',
          errorDocument: 'error/404.html',
        }
      : { enabled: false };
    const { data } = await this.http.put<GarageBucketInfo>(
      `/v1/bucket?id=${encodeURIComponent(id)}`,
      { websiteAccess },
    );
    return { public: data.websiteAccess === true };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable()
export class GarageS3Adapter implements ObjectStoreEngineAdapter {
  readonly engines: ObjectStoreEngine[] = ['garage'];

  connect(params: ObjectStoreConnectParams): Promise<ObjectStoreConnection> {
    const client = new S3Client({
      endpoint: `http://${params.host}:${params.port}`,
      region: params.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: params.accessKeyId,
        secretAccessKey: params.secretAccessKey,
      },
      // Bound every request so a stalled tunnel surfaces as an error instead of
      // hanging the console (and holding the tunnel lease open) forever.
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 15_000,
        requestTimeout: 30_000,
      }),
    });
    return Promise.resolve(new GarageS3Connection(client));
  }

  connectAdmin(
    params: ObjectStoreAdminConnectParams,
  ): Promise<ObjectStoreAdminConnection> {
    const http = axios.create({
      baseURL: `http://${params.host}:${params.port}`,
      timeout: 15_000,
      headers: { Authorization: `Bearer ${params.token}` },
    });
    return Promise.resolve(new GarageAdminConnection(http));
  }
}
