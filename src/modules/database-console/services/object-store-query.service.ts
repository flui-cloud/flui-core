import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  BucketPolicy,
  ObjectStoreAdminConnection,
  ObjectStoreConnection,
  ObjectStoreEngine,
  ObjectStoreEngineAdapter,
  OBJECT_STORE_ENGINE_ADAPTERS,
  OBJECT_STORE_PROFILES,
  S3Bucket,
  S3ObjectBody,
  S3ObjectMeta,
  S3Listing,
} from '../engine/object-store-engine';
import {
  ObjectStoreConnectionInfo,
  ObjectStoreResolveInput,
  ResolvedObjectStoreConnection,
} from '../interfaces/object-store-connection';
import { ObjectStoreConnectionResolver } from './object-store-connection.resolver';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/** A streaming object pull whose tunnel stays open until the caller disposes it. */
export interface ObjectStream {
  body: S3ObjectBody;
  dispose: () => Promise<void>;
}

/**
 * Object-storage counterpart to DocumentQueryService: same ephemeral-tunnel
 * transport and audit, but speaks the S3 ObjectStoreConnection contract. All
 * object I/O is proxied through the backend over the tunnel — the store stays
 * cluster-internal and its secret key never leaves the cluster.
 */
@Injectable()
export class ObjectStoreQueryService {
  private readonly adapters: Map<ObjectStoreEngine, ObjectStoreEngineAdapter>;

  constructor(
    private readonly resolver: ObjectStoreConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(OBJECT_STORE_ENGINE_ADAPTERS)
    adapters: ObjectStoreEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  listBuckets(input: ObjectStoreResolveInput): Promise<S3Bucket[]> {
    return this.withConnection(input, 's3.listBuckets', true, (c) =>
      c.listBuckets(),
    );
  }

  createBucket(
    input: ObjectStoreResolveInput,
    bucket: string,
    opts: { readOnly: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 's3.createBucket', false, (c) =>
      c.createBucket(bucket),
    );
  }

  deleteBucket(
    input: ObjectStoreResolveInput,
    bucket: string,
    opts: { readOnly: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 's3.deleteBucket', false, (c) =>
      c.deleteBucket(bucket),
    );
  }

  getBucketPolicy(
    input: ObjectStoreResolveInput,
    bucket: string,
  ): Promise<BucketPolicy> {
    return this.withAdmin(input, 's3.getBucketPolicy', true, (c) =>
      c.getBucketPolicy(bucket),
    );
  }

  setBucketPolicy(
    input: ObjectStoreResolveInput,
    bucket: string,
    isPublic: boolean,
    opts: { readOnly: boolean },
  ): Promise<BucketPolicy> {
    this.assertWritable(opts.readOnly);
    return this.withAdmin(input, 's3.setBucketPolicy', false, (c) =>
      c.setBucketPolicy(bucket, isPublic),
    );
  }

  listObjects(
    input: ObjectStoreResolveInput,
    bucket: string,
    opts: {
      prefix?: string;
      delimiter?: string;
      continuationToken?: string;
      maxKeys?: number;
    },
  ): Promise<S3Listing> {
    return this.withConnection(input, 's3.listObjects', true, (c) =>
      c.listObjects(bucket, opts),
    );
  }

  headObject(
    input: ObjectStoreResolveInput,
    bucket: string,
    key: string,
  ): Promise<S3ObjectMeta> {
    return this.withConnection(input, 's3.headObject', true, (c) =>
      c.headObject(bucket, key),
    );
  }

  putObject(
    input: ObjectStoreResolveInput,
    bucket: string,
    key: string,
    body: Readable | Buffer,
    opts: { contentType?: string; contentLength?: number; readOnly: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 's3.putObject', false, (c) =>
      c.putObject(bucket, key, body, opts),
    );
  }

  deleteObject(
    input: ObjectStoreResolveInput,
    bucket: string,
    key: string,
    opts: { readOnly: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 's3.deleteObject', false, (c) =>
      c.deleteObject(bucket, key),
    );
  }

  /** Delete every object under a prefix ("folder"), paging the listing. */
  async deletePrefix(
    input: ObjectStoreResolveInput,
    bucket: string,
    prefix: string,
    opts: { readOnly: boolean },
  ): Promise<number> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 's3.deletePrefix', false, async (c) => {
      let token: string | undefined;
      let deleted = 0;
      do {
        const page = await c.listObjects(bucket, {
          prefix,
          continuationToken: token,
          maxKeys: 1000,
        });
        const keys = page.objects.map((o) => o.key);
        if (keys.length) {
          await c.deleteObjects(bucket, keys);
          deleted += keys.length;
        }
        token = page.isTruncated ? page.continuationToken : undefined;
      } while (token);
      return deleted;
    });
  }

  /**
   * Open an object for streaming download. The tunnel + S3 client stay alive
   * until the caller invokes `dispose` (after the response stream finishes).
   */
  async openObjectStream(
    input: ObjectStoreResolveInput,
    bucket: string,
    key: string,
  ): Promise<ObjectStream> {
    const { conn, dispose } = await this.openConnection(input);
    try {
      const body = await conn.getObject(bucket, key);
      this.audit.emit({
        dbInstallId: input.appId,
        userId: input.fluiUserId,
        role: 'owner',
        command: 's3.getObject',
        rowCount: 0,
        readOnly: true,
        durationMs: 0,
        failed: false,
      });
      return { body, dispose };
    } catch (err) {
      await dispose();
      this.audit.emit({
        dbInstallId: input.appId,
        userId: input.fluiUserId,
        role: 'owner',
        command: 's3.getObject',
        rowCount: 0,
        readOnly: true,
        durationMs: 0,
        failed: true,
      });
      throw err;
    }
  }

  async connectionInfo(
    input: ObjectStoreResolveInput,
  ): Promise<ObjectStoreConnectionInfo> {
    const resolved = await this.resolver.resolve(input);
    return {
      engine: resolved.engine,
      label: OBJECT_STORE_PROFILES[resolved.engine].label,
      region: resolved.region,
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
      defaultBucket: resolved.defaultBucket,
    };
  }

  private adapterFor(engine: ObjectStoreEngine): ObjectStoreEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(
        `Engine "${engine}" is not an object store`,
      );
    }
    return adapter;
  }

  /** Open tunnel + connect; caller owns the returned dispose. */
  private async openConnection(input: ObjectStoreResolveInput): Promise<{
    conn: ObjectStoreConnection;
    resolved: ResolvedObjectStoreConnection;
    dispose: () => Promise<void>;
  }> {
    const resolved = await this.resolver.resolve(input);
    const adapter = this.adapterFor(resolved.engine);
    const kubeconfig = await this.clusters.getKubeconfig(
      resolved.target.clusterId,
    );
    const tunnel = await this.portForward.open(
      kubeconfig,
      resolved.target.namespace,
      resolved.target.podLabelSelector,
      resolved.target.port,
    );
    const conn = await adapter.connect({
      host: '127.0.0.1',
      port: tunnel.localPort,
      region: resolved.region,
      accessKeyId: resolved.accessKeyId,
      secretAccessKey: resolved.secretAccessKey,
    });
    const dispose = async (): Promise<void> => {
      await conn.close();
      await tunnel.dispose();
    };
    return { conn, resolved, dispose };
  }

  /** Open an admin tunnel (admin port + token) for bucket-policy ops. */
  private async withAdmin<T>(
    input: ObjectStoreResolveInput,
    command: string,
    readOnly: boolean,
    fn: (conn: ObjectStoreAdminConnection) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const resolved = await this.resolver.resolve(input);
    if (!resolved.adminToken) {
      throw new BadRequestException(
        `${OBJECT_STORE_PROFILES[resolved.engine].label} exposes no admin API for bucket policy`,
      );
    }
    const adapter = this.adapterFor(resolved.engine);
    const kubeconfig = await this.clusters.getKubeconfig(
      resolved.target.clusterId,
    );
    const tunnel = await this.portForward.open(
      kubeconfig,
      resolved.target.namespace,
      resolved.target.podLabelSelector,
      resolved.target.adminPort,
    );
    try {
      const conn = await adapter.connectAdmin({
        host: '127.0.0.1',
        port: tunnel.localPort,
        token: resolved.adminToken,
      });
      try {
        const result = await fn(conn);
        this.audit.emit({
          dbInstallId: input.appId,
          userId: input.fluiUserId,
          role: 'owner',
          command,
          rowCount: 0,
          readOnly,
          durationMs: Date.now() - started,
          failed: false,
        });
        return result;
      } finally {
        await conn.close();
      }
    } catch (err) {
      this.audit.emit({
        dbInstallId: input.appId,
        userId: input.fluiUserId,
        role: 'owner',
        command,
        rowCount: 0,
        readOnly,
        durationMs: Date.now() - started,
        failed: true,
      });
      throw err;
    } finally {
      await tunnel.dispose();
    }
  }

  private assertWritable(readOnly: boolean): void {
    if (readOnly) {
      throw new ForbiddenException(
        'Read-only mode is on — turn it off to create, upload or delete.',
      );
    }
  }

  private async withConnection<T>(
    input: ObjectStoreResolveInput,
    command: string,
    isRead: boolean,
    fn: (conn: ObjectStoreConnection) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const { conn, dispose } = await this.openConnection(input);
    try {
      const result = await fn(conn);
      this.audit.emit({
        dbInstallId: input.appId,
        userId: input.fluiUserId,
        role: 'owner',
        command,
        rowCount: 0,
        readOnly: isRead,
        durationMs: Date.now() - started,
        failed: false,
      });
      return result;
    } catch (err) {
      this.audit.emit({
        dbInstallId: input.appId,
        userId: input.fluiUserId,
        role: 'owner',
        command,
        rowCount: 0,
        readOnly: isRead,
        durationMs: Date.now() - started,
        failed: true,
      });
      throw err;
    } finally {
      await dispose();
    }
  }
}
