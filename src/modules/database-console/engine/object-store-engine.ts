import { Readable } from 'node:stream';

/**
 * Object-storage engine family. Garage today; the adapter is plain S3 so any
 * S3-wire store (MinIO, SeaweedFS, real S3) can be added by one profile entry.
 */
export type ObjectStoreEngine = 'garage';

/** A bucket in the store. */
export interface S3Bucket {
  name: string;
  creationDate?: string;
}

/** One object key in a listing (carries metadata only, never the body). */
export interface S3ObjectEntry {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
}

/**
 * One page of a delimited listing — `prefixes` are the sub-"folders" under the
 * current prefix (S3 common prefixes), `objects` the keys directly at this level.
 */
export interface S3Listing {
  prefix: string;
  delimiter: string;
  prefixes: string[];
  objects: S3ObjectEntry[];
  isTruncated: boolean;
  continuationToken?: string;
  keyCount: number;
}

/** Full metadata of a single object (HEAD). */
export interface S3ObjectMeta {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: string;
  etag?: string;
  metadata?: Record<string, string>;
}

/** A readable object body plus the headers needed to serve it back to a browser. */
export interface S3ObjectBody {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
}

export interface ObjectStoreConnectParams {
  host: string;
  port: number;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ObjectStoreAdminConnectParams {
  host: string;
  port: number;
  token: string;
}

/** Light, engine-neutral bucket visibility. `public` = anonymous read enabled. */
export interface BucketPolicy {
  public: boolean;
}

/**
 * Admin session for bucket policy (separate port + bearer token from the S3 API).
 * On Garage, `public` maps to the bucket's website-access flag.
 */
export interface ObjectStoreAdminConnection {
  getBucketPolicy(bucket: string): Promise<BucketPolicy>;
  setBucketPolicy(bucket: string, isPublic: boolean): Promise<BucketPolicy>;
  close(): Promise<void>;
}

/** A live S3 session against one store. Owns the underlying S3 client. */
export interface ObjectStoreConnection {
  listBuckets(): Promise<S3Bucket[]>;
  createBucket(bucket: string): Promise<void>;
  deleteBucket(bucket: string): Promise<void>;
  listObjects(
    bucket: string,
    opts: {
      prefix?: string;
      delimiter?: string;
      continuationToken?: string;
      maxKeys?: number;
    },
  ): Promise<S3Listing>;
  headObject(bucket: string, key: string): Promise<S3ObjectMeta>;
  getObject(bucket: string, key: string): Promise<S3ObjectBody>;
  putObject(
    bucket: string,
    key: string,
    body: Readable | Buffer,
    opts: { contentType?: string; contentLength?: number },
  ): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
  /** Bulk delete (used to remove a whole prefix/"folder"). */
  deleteObjects(bucket: string, keys: string[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Per-engine object-store adapter. One implementation can serve several S3-wire
 * stores, so `engines` is a list — mirrors DocumentEngineAdapter.
 */
export interface ObjectStoreEngineAdapter {
  readonly engines: ObjectStoreEngine[];
  connect(params: ObjectStoreConnectParams): Promise<ObjectStoreConnection>;
  /** Admin session (admin port + token) for bucket policy. */
  connectAdmin(
    params: ObjectStoreAdminConnectParams,
  ): Promise<ObjectStoreAdminConnection>;
}

/** DI token for the set of available object-store engine adapters. */
export const OBJECT_STORE_ENGINE_ADAPTERS = Symbol(
  'OBJECT_STORE_ENGINE_ADAPTERS',
);

/** Engine-specific wiring resolved from the installed building block. */
export interface ObjectStoreProfile {
  engine: ObjectStoreEngine;
  label: string;
  /** In-cluster S3 API port. */
  s3Port: number;
  /** In-cluster admin API port (bucket policy). */
  adminPort: number;
  /** SigV4 region the store validates the signature against. */
  region: string;
  /** Secret keys (first present wins) holding the S3 access key id. */
  accessKeySecretKeys: string[];
  /** Secret keys holding the S3 secret access key. */
  secretKeySecretKeys: string[];
  /** Secret keys holding the admin API bearer token. */
  adminTokenSecretKeys: string[];
  /** Env names (plaintext) carrying the bucket auto-created at install. */
  defaultBucketEnvKeys: string[];
  /** Matches the building-block image so the engine can be inferred from it. */
  imagePattern: RegExp;
}

export const OBJECT_STORE_PROFILES: Record<
  ObjectStoreEngine,
  ObjectStoreProfile
> = {
  garage: {
    engine: 'garage',
    label: 'Garage',
    s3Port: 3900,
    adminPort: 3903,
    // Matches `s3_region` in the seeded garage.toml.
    region: 'garage',
    accessKeySecretKeys: ['GARAGE_DEFAULT_ACCESS_KEY'],
    secretKeySecretKeys: ['GARAGE_DEFAULT_SECRET_KEY'],
    adminTokenSecretKeys: ['GARAGE_ADMIN_TOKEN'],
    defaultBucketEnvKeys: ['GARAGE_DEFAULT_BUCKET'],
    imagePattern: /garage/i,
  },
};

export function detectObjectStoreEngine(
  imageRef?: string,
): ObjectStoreEngine | null {
  if (!imageRef) return null;
  for (const profile of Object.values(OBJECT_STORE_PROFILES)) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}
