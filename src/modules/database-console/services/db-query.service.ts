import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  DB_CONNECTION_RESOLVER,
  DbConnectionInfo,
  DbConnectionResolveInput,
  DbConnectionResolver,
  DbEngine,
  ResolvedDbConnection,
} from '../interfaces/db-connection';
import {
  SQL_ENGINE_ADAPTERS,
  SchemaTree,
  SqlEngineAdapter,
  SqlEngineConnection,
  SqlQueryOptions,
  SqlQueryResult,
} from '../engine/sql-engine';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

export interface RunQueryParams {
  readOnly: boolean;
  statementTimeoutMs: number;
  maxRows: number;
}

@Injectable()
export class DbQueryService {
  // engine → adapter, built once from the DI-registered set. No engine branching here.
  private readonly adapters: Map<DbEngine, SqlEngineAdapter>;

  constructor(
    @Inject(DB_CONNECTION_RESOLVER)
    private readonly connectionResolver: DbConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(SQL_ENGINE_ADAPTERS)
    sqlEngineAdapters: SqlEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map(sqlEngineAdapters.map((a) => [a.engine, a]));
  }

  async runQuery(
    input: DbConnectionResolveInput,
    sql: string,
    params: RunQueryParams,
  ): Promise<SqlQueryResult> {
    return this.withConnection(input, async (conn, resolved) => {
      const opts: SqlQueryOptions = {
        readOnly: params.readOnly,
        statementTimeoutMs: params.statementTimeoutMs,
        maxRows: params.maxRows,
      };
      try {
        const result = await conn.query(sql, opts);
        this.audit.emit({
          dbInstallId: input.dbInstallId,
          userId: input.fluiUserId,
          role: resolved.role,
          command: result.command,
          rowCount: result.rowCount,
          readOnly: opts.readOnly,
          durationMs: result.durationMs,
          failed: false,
        });
        return result;
      } catch (err) {
        this.audit.emit({
          dbInstallId: input.dbInstallId,
          userId: input.fluiUserId,
          role: resolved.role,
          command: '',
          rowCount: 0,
          readOnly: opts.readOnly,
          durationMs: 0,
          failed: true,
        });
        throw err;
      }
    });
  }

  async introspect(input: DbConnectionResolveInput): Promise<SchemaTree> {
    return this.withConnection(input, (conn) => conn.introspect());
  }

  // NON-SECRET connection coordinates (no DB connection opened, no password). The
  // password never crosses the HTTP API — the CLI reads it from the in-cluster Secret.
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

  private adapterFor(engine: DbEngine): SqlEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(`Unsupported database engine: ${engine}`);
    }
    return adapter;
  }

  // Opens an ephemeral tunnel + driver session for the duration of one call and
  // always tears both down. Connection/tunnel caching is a later optimization.
  private async withConnection<T>(
    input: DbConnectionResolveInput,
    fn: (
      conn: SqlEngineConnection,
      resolved: ResolvedDbConnection,
    ) => Promise<T>,
  ): Promise<T> {
    const resolved = await this.connectionResolver.resolve(input);
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
      const conn = await this.adapterFor(resolved.engine).connect({
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
   * Map a connection/auth failure to a readable 400 instead of an opaque 500.
   * Query-time errors are already mapped to HttpExceptions inside the adapters;
   * this only catches connect-time faults (wrong password, unreachable host,
   * missing database). Unknown errors are left to surface as 500.
   */
  private toClientError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    const e = err as { code?: string; message?: string };
    const CONNECT_CODES = new Set([
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EHOSTUNREACH',
      '28P01', // pg: invalid password
      '28000', // pg/maria: invalid authorization
      '3D000', // pg: database does not exist
      'ER_ACCESS_DENIED_ERROR',
      'ER_DBACCESS_DENIED_ERROR',
      'ER_BAD_DB_ERROR',
    ]);
    if (e?.code && CONNECT_CODES.has(e.code) && e.message) {
      return new BadRequestException(e.message);
    }
    return err;
  }
}
