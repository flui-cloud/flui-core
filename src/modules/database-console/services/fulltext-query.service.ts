import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  FULLTEXT_CLASSIFIERS,
  FULLTEXT_ENGINE_ADAPTERS,
  FULLTEXT_PROFILES,
  FulltextConnection,
  FulltextEngine,
  FulltextEngineAdapter,
  FulltextIndex,
  FulltextSearchParams,
  FulltextSearchResult,
  FulltextServerInfo,
} from '../engine/fulltext-engine';
import { RawRestRequest, RawRestResponse } from '../engine/raw-rest';
import {
  FulltextConnectionInfo,
  FulltextResolveInput,
  ResolvedFulltextConnection,
} from '../interfaces/fulltext-connection';
import { FulltextConnectionResolver } from './fulltext-connection.resolver';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/**
 * Full-text (Meilisearch) console query service: same tunnel + audit lifecycle as
 * the other consoles. Search and metadata reads are always allowed; the Dev Tools
 * raw passthrough gates writes behind the read-only flag via the engine classifier.
 */
@Injectable()
export class FulltextQueryService {
  private readonly adapters: Map<FulltextEngine, FulltextEngineAdapter>;

  constructor(
    private readonly resolver: FulltextConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(FULLTEXT_ENGINE_ADAPTERS)
    adapters: FulltextEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  serverInfo(input: FulltextResolveInput): Promise<FulltextServerInfo> {
    return this.withConnection(input, 'fulltext.info', (c) => c.serverInfo());
  }

  listIndexes(input: FulltextResolveInput): Promise<FulltextIndex[]> {
    return this.withConnection(input, 'fulltext.listIndexes', (c) =>
      c.listIndexes(),
    );
  }

  search(
    input: FulltextResolveInput,
    index: string,
    params: FulltextSearchParams,
  ): Promise<FulltextSearchResult> {
    return this.withConnection(input, 'fulltext.search', (c) =>
      c.search(index, params),
    );
  }

  async runRaw(
    input: FulltextResolveInput,
    req: RawRestRequest,
    opts: { readOnly: boolean },
  ): Promise<RawRestResponse> {
    const started = Date.now();
    const session = await this.openSession(input);
    const classify = FULLTEXT_CLASSIFIERS[session.resolved.engine];
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
    input: FulltextResolveInput,
  ): Promise<FulltextConnectionInfo> {
    const resolved = await this.resolver.resolve(input);
    return {
      engine: resolved.engine,
      label: FULLTEXT_PROFILES[resolved.engine].label,
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
    };
  }

  private adapterFor(engine: FulltextEngine): FulltextEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(
        `Engine "${engine}" is not a full-text engine`,
      );
    }
    return adapter;
  }

  private emitAudit(
    input: FulltextResolveInput,
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

  private async openSession(input: FulltextResolveInput): Promise<{
    resolved: ResolvedFulltextConnection;
    conn: FulltextConnection;
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
    let conn: FulltextConnection;
    try {
      conn = await adapter.connect({
        host: '127.0.0.1',
        port: tunnel.localPort,
        apiKey: resolved.apiKey,
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
    input: FulltextResolveInput,
    command: string,
    fn: (conn: FulltextConnection) => Promise<T>,
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
