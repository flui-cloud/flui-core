import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  CACHE_ENGINE_ADAPTERS,
  CacheConnection,
  CacheEngine,
  CacheEngineAdapter,
  CacheEntry,
  CacheServerInfo,
  CacheSetInput,
  CACHE_PROFILES,
} from '../engine/cache-engine';
import {
  CacheConnectionInfo,
  CacheResolveInput,
} from '../interfaces/cache-connection';
import { CacheConnectionResolver } from './cache-connection.resolver';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/**
 * Cache console query service. Same ephemeral-tunnel transport + audit as the
 * other consoles, speaking the CacheConnection contract. Reads (serverInfo, get)
 * always run; writes (set, delete, flush) are refused when the request is in
 * read-only mode — defense in depth alongside the disabled UI controls.
 */
@Injectable()
export class CacheQueryService {
  private readonly adapters: Map<CacheEngine, CacheEngineAdapter>;

  constructor(
    private readonly resolver: CacheConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(CACHE_ENGINE_ADAPTERS) adapters: CacheEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  serverInfo(input: CacheResolveInput): Promise<CacheServerInfo> {
    return this.withConnection(input, 'cache.serverInfo', true, (c) =>
      c.serverInfo(),
    );
  }

  get(input: CacheResolveInput, key: string): Promise<CacheEntry | null> {
    return this.withConnection(input, 'cache.get', true, (c) => c.get(key));
  }

  set(
    input: CacheResolveInput,
    set: CacheSetInput,
    opts: { readOnly: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 'cache.set', false, (c) => c.set(set));
  }

  delete(
    input: CacheResolveInput,
    key: string,
    opts: { readOnly: boolean },
  ): Promise<boolean> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 'cache.delete', false, (c) =>
      c.delete(key),
    );
  }

  flush(input: CacheResolveInput, opts: { readOnly: boolean }): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 'cache.flush', false, (c) =>
      c.flushAll(),
    );
  }

  async connectionInfo(input: CacheResolveInput): Promise<CacheConnectionInfo> {
    const resolved = await this.resolver.resolve(input);
    return {
      engine: resolved.engine,
      label: CACHE_PROFILES[resolved.engine].label,
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
    };
  }

  private assertWritable(readOnly: boolean): void {
    if (readOnly) {
      throw new ForbiddenException(
        'Read-only mode is on — turn it off to write to the cache.',
      );
    }
  }

  private adapterFor(engine: CacheEngine): CacheEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(`Engine "${engine}" is not a cache server`);
    }
    return adapter;
  }

  private toClientError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    const e = err as { clientMessage?: string };
    if (e?.clientMessage) return new BadRequestException(e.clientMessage);
    return err;
  }

  private async withConnection<T>(
    input: CacheResolveInput,
    command: string,
    readOnly: boolean,
    fn: (conn: CacheConnection) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
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
    try {
      const conn = await adapter.connect({
        host: '127.0.0.1',
        port: tunnel.localPort,
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
      throw this.toClientError(err);
    } finally {
      await tunnel.dispose();
    }
  }
}
