import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  SearchClusterInfo,
  SearchConnection,
  SearchEngine,
  SearchEngineAdapter,
  SearchIndex,
  SearchResponse,
  SEARCH_ENGINE_ADAPTERS,
  SEARCH_PROFILES,
} from '../engine/search-engine';
import {
  RawRestRequest,
  RawRestResponse,
  REST_CLASSIFIERS,
} from '../engine/raw-rest';
import {
  ResolvedSearchConnection,
  SearchConnectionInfo,
  SearchResolveInput,
} from '../interfaces/search-connection';
import { SearchConnectionResolver } from './search-connection.resolver';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/**
 * Read-only search console query service: same ephemeral-tunnel transport and
 * audit as the other consoles, speaking the SearchConnection contract. Only
 * read operations are exposed (list/mapping/search/count) — the console is a
 * viewer, never a way to mutate or drop indices.
 */
@Injectable()
export class SearchQueryService {
  private readonly adapters: Map<SearchEngine, SearchEngineAdapter>;

  constructor(
    private readonly resolver: SearchConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(SEARCH_ENGINE_ADAPTERS)
    adapters: SearchEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  clusterInfo(input: SearchResolveInput): Promise<SearchClusterInfo> {
    return this.withConnection(input, 'search.info', (c) => c.clusterInfo());
  }

  listIndices(input: SearchResolveInput): Promise<SearchIndex[]> {
    return this.withConnection(input, 'search.listIndices', (c) =>
      c.listIndices(),
    );
  }

  getMapping(
    input: SearchResolveInput,
    index: string,
  ): Promise<Record<string, unknown>> {
    return this.withConnection(input, 'search.getMapping', (c) =>
      c.getMapping(index),
    );
  }

  search(
    input: SearchResolveInput,
    index: string,
    body: Record<string, unknown>,
    opts: { from: number; size: number },
  ): Promise<SearchResponse> {
    return this.withConnection(input, 'search.search', (c) =>
      c.search(index, body, opts),
    );
  }

  count(
    input: SearchResolveInput,
    index: string,
    body?: Record<string, unknown>,
  ): Promise<number> {
    return this.withConnection(input, 'search.count', (c) =>
      c.count(index, body),
    );
  }

  /**
   * Raw REST passthrough for the Dev Tools console. The read-only gate (on by
   * default) rejects any request the engine classifier flags as a mutation;
   * every call is audited with its real read/write nature.
   */
  async runRaw(
    input: SearchResolveInput,
    req: RawRestRequest,
    opts: { readOnly: boolean },
  ): Promise<RawRestResponse> {
    const started = Date.now();
    const session = await this.openSession(input);
    const classify = REST_CLASSIFIERS[session.resolved.engine];
    const kind = classify ? classify(req) : 'write';
    const command = `raw ${req.method} ${req.path}`;
    try {
      if (opts.readOnly && kind === 'write') {
        throw new ForbiddenException(
          'Read-only mode is on. This request would modify data or settings — turn off read-only to run it.',
        );
      }
      const result = await session.conn.raw(req);
      this.emitAudit(input, command, kind === 'read', started, false);
      return result;
    } catch (err) {
      this.emitAudit(input, command, opts.readOnly, started, true);
      throw err;
    } finally {
      await session.dispose();
    }
  }

  async connectionInfo(
    input: SearchResolveInput,
  ): Promise<SearchConnectionInfo> {
    const resolved = await this.resolver.resolve(input);
    return {
      engine: resolved.engine,
      label: SEARCH_PROFILES[resolved.engine].label,
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
      useTls: resolved.useTls,
    };
  }

  private adapterFor(engine: SearchEngine): SearchEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(`Engine "${engine}" is not a search store`);
    }
    return adapter;
  }

  private emitAudit(
    input: SearchResolveInput,
    command: string,
    readOnly: boolean,
    started: number,
    failed: boolean,
  ): void {
    this.audit.emit({
      dbInstallId: input.appId,
      userId: input.fluiUserId,
      role: 'owner',
      command,
      rowCount: 0,
      readOnly,
      durationMs: Date.now() - started,
      failed,
    });
  }

  /** Resolve + tunnel + connect; caller disposes (closes conn, then tunnel). */
  private async openSession(input: SearchResolveInput): Promise<{
    resolved: ResolvedSearchConnection;
    conn: SearchConnection;
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
    let conn: SearchConnection;
    try {
      conn = await adapter.connect({
        host: '127.0.0.1',
        port: tunnel.localPort,
        username: resolved.username,
        password: resolved.password,
        useTls: resolved.useTls,
      });
    } catch (err) {
      await tunnel.dispose();
      throw err;
    }
    return {
      resolved,
      conn,
      dispose: async () => {
        try {
          await conn.close();
        } finally {
          await tunnel.dispose();
        }
      },
    };
  }

  private async withConnection<T>(
    input: SearchResolveInput,
    command: string,
    fn: (conn: SearchConnection) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const session = await this.openSession(input);
    try {
      const result = await fn(session.conn);
      this.emitAudit(input, command, true, started, false);
      return result;
    } catch (err) {
      this.emitAudit(input, command, true, started, true);
      throw err;
    } finally {
      await session.dispose();
    }
  }
}
