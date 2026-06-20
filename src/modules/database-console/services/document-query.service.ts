import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { BSON } from 'mongodb';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  DbConnectionInfo,
  DbConnectionResolveInput,
  DbConnectionResolver,
  DbEngine,
  DB_CONNECTION_RESOLVER,
  ResolvedDbConnection,
} from '../interfaces/db-connection';
import {
  CommandResult,
  DocumentCollection,
  DocumentConnection,
  DocumentDatabase,
  DocumentEngineAdapter,
  DocumentField,
  DocumentFindOptions,
  DocumentPage,
  DocumentStoreSummary,
  ShellResult,
  DOCUMENT_ENGINE_ADAPTERS,
} from '../engine/document-engine';
import { translateShellStatement } from '../engine/mongo-shell';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/**
 * Document counterpart to DbQueryService/KvQueryService: same transport (ephemeral tunnel) and
 * resolver seam, but it speaks the DocumentEngineAdapter contract (database/collection browse +
 * command) instead of SQL or key-value. Browse operations are reads; arbitrary commands go
 * through the read-only gate.
 */
@Injectable()
export class DocumentQueryService {
  private readonly adapters: Map<DbEngine, DocumentEngineAdapter>;

  constructor(
    @Inject(DB_CONNECTION_RESOLVER)
    private readonly connectionResolver: DbConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(DOCUMENT_ENGINE_ADAPTERS)
    documentAdapters: DocumentEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of documentAdapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  summary(input: DbConnectionResolveInput): Promise<DocumentStoreSummary> {
    return this.withConnection(input, (conn) => conn.summary());
  }

  databases(input: DbConnectionResolveInput): Promise<DocumentDatabase[]> {
    return this.withConnection(input, (conn) => conn.databases());
  }

  collections(
    input: DbConnectionResolveInput,
    database: string,
  ): Promise<DocumentCollection[]> {
    return this.withConnection(input, (conn) => conn.collections(database));
  }

  find(
    input: DbConnectionResolveInput,
    database: string,
    collection: string,
    opts: DocumentFindOptions,
  ): Promise<DocumentPage> {
    return this.withConnection(input, (conn) =>
      conn.find(database, collection, opts),
    );
  }

  // Infer the collection's field structure for query autocomplete. The random
  // $sample (spread across the whole collection) + newest-by-_id union avoids
  // clustering on time-adjacent docs, so fields added as the schema evolved show up.
  fields(
    input: DbConnectionResolveInput,
    database: string,
    collection: string,
  ): Promise<DocumentField[]> {
    return this.withConnection(input, (conn) =>
      conn.fields(database, collection, { sampleSize: 200, recent: 25 }),
    );
  }

  async runCommand(
    input: DbConnectionResolveInput,
    database: string,
    command: Record<string, unknown>,
    readOnly: boolean,
  ): Promise<CommandResult> {
    return this.withConnection(input, async (conn, resolved) => {
      const name = String(Object.keys(command)[0] ?? '');
      try {
        const result = await conn.command(database, command, { readOnly });
        this.audit.emit({
          dbInstallId: input.dbInstallId,
          userId: input.fluiUserId,
          role: resolved.role,
          command: name,
          rowCount: 0,
          readOnly,
          durationMs: result.durationMs,
          failed: false,
        });
        return result;
      } catch (err) {
        this.audit.emit({
          dbInstallId: input.dbInstallId,
          userId: input.fluiUserId,
          role: resolved.role,
          command: name,
          rowCount: 0,
          readOnly,
          durationMs: 0,
          failed: true,
        });
        throw err;
      }
    });
  }

  // Evaluate one mongosh-syntax statement: translate it to a Mongo command (no JS eval,
  // anywhere) and run it through the same read-only-gated command path (audit + EJSON).
  // BSON values produced by the parser are re-serialized to Extended JSON so the gate's
  // decoder hands the driver real BSON — identical contract to the `command` endpoint.
  async runShell(
    input: DbConnectionResolveInput,
    currentDb: string,
    statement: string,
    readOnly: boolean,
  ): Promise<ShellResult> {
    const planned = translateShellStatement(statement, currentDb);
    const ejsonCommand = BSON.EJSON.serialize(planned.command, {
      relaxed: false,
    }) as Record<string, unknown>;
    const result = await this.runCommand(
      input,
      planned.database,
      ejsonCommand,
      readOnly,
    );
    return {
      database: planned.database,
      method: planned.method,
      shape: planned.shape,
      mutation: planned.mutation,
      reply: result.reply,
      durationMs: result.durationMs,
    };
  }

  // NON-SECRET connection coordinates (no DB connection opened, no password). The password
  // never crosses the HTTP API — the CLI reads it from the in-cluster Secret.
  async connectionInfo(
    input: DbConnectionResolveInput,
  ): Promise<DbConnectionInfo> {
    const resolved = await this.connectionResolver.resolve(input);
    return {
      engine: resolved.engine,
      database: resolved.credentials.database ?? '',
      user: resolved.credentials.user ?? '',
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
    };
  }

  private adapterFor(engine: DbEngine): DocumentEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(
        `Application engine "${engine}" is not a document store`,
      );
    }
    return adapter;
  }

  private async withConnection<T>(
    input: DbConnectionResolveInput,
    fn: (
      conn: DocumentConnection,
      resolved: ResolvedDbConnection,
    ) => Promise<T>,
  ): Promise<T> {
    const resolved = await this.connectionResolver.resolve(input);
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
        credentials: resolved.credentials,
      });
      try {
        return await fn(conn, resolved);
      } finally {
        await conn.close();
      }
    } catch (err) {
      throw this.toClientError(err);
    } finally {
      await tunnel.dispose();
    }
  }

  /**
   * Map a connect-time failure to a readable 400 instead of an opaque 500.
   * Query errors are already mapped inside the adapter; this catches unreachable
   * host / auth failures. Unknown errors are left to surface as 500.
   */
  private toClientError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    const e = err as { code?: string; codeName?: string; message?: string };
    const NET_CODES = new Set([
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EHOSTUNREACH',
    ]);
    const isAuth =
      e?.codeName === 'AuthenticationFailed' || e?.codeName === 'Unauthorized';
    if (((e?.code && NET_CODES.has(e.code)) || isAuth) && e.message) {
      return new BadRequestException(e.message);
    }
    return err;
  }
}
