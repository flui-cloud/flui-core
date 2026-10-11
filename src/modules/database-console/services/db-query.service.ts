import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
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
  ReaderRole,
  SQL_ENGINE_ADAPTERS,
  SchemaTree,
  SqlEngineAdapter,
  SqlEngineConnection,
  SqlQueryOptions,
  SqlQueryResult,
} from '../engine/sql-engine';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/** The role a reader's queries run as, created on first use by the owner session. */
export const READER_ROLE_NAME = 'flui_reader';
export const READER_STATEMENT_TIMEOUT_MS = 5_000;
const READER_CONNECTION_LIMIT = 5;
/** Grants are re-applied this often, so tables created since are readable too. */
const READER_REFRESH_MS = 10 * 60_000;

export interface RunQueryParams {
  readOnly: boolean;
  statementTimeoutMs: number;
  maxRows: number;
}

@Injectable()
export class DbQueryService {
  // engine → adapter, built once from the DI-registered set. No engine branching here.
  private readonly adapters: Map<DbEngine, SqlEngineAdapter>;
  /**
   * The reader password per database, held in memory only. A restart, or another
   * copy of the API, simply sets a new one the next time it is needed — and a
   * copy whose password was replaced under it sets its own on the refused login.
   */
  private readonly readers = new Map<
    string,
    { password: string; at: number }
  >();

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
      const conn =
        input.access === 'reader'
          ? await this.connectAsReader(
              input.dbInstallId,
              resolved,
              tunnel.localPort,
            )
          : await this.adapterFor(resolved.engine).connect({
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
   * A session as the reader role, never as the owner. The owner session is
   * opened only to create the role or reset its password, and closed before the
   * reader's statement is sent.
   */
  private async connectAsReader(
    appId: string,
    resolved: ResolvedDbConnection,
    port: number,
  ): Promise<SqlEngineConnection> {
    const adapter = this.adapterFor(resolved.engine);
    const database = resolved.credentials.database ?? '';
    const as = (password: string) =>
      adapter.connect({
        host: '127.0.0.1',
        port,
        credentials: { user: READER_ROLE_NAME, password, database },
      });
    const known = this.readers.get(appId);
    if (known && Date.now() - known.at < READER_REFRESH_MS) {
      try {
        return await as(known.password);
      } catch (err) {
        if ((err as { code?: string }).code !== '28P01') throw err;
      }
    }
    const role: ReaderRole = {
      name: READER_ROLE_NAME,
      password: randomBytes(24).toString('base64url'),
      database,
      connectionLimit: READER_CONNECTION_LIMIT,
      statementTimeoutMs: READER_STATEMENT_TIMEOUT_MS,
    };
    const owner = await adapter.connect({
      host: '127.0.0.1',
      port,
      credentials: resolved.credentials,
    });
    try {
      if (!owner.ensureReaderRole) {
        throw new ForbiddenException(
          'This database can only be opened by its owner.',
        );
      }
      await owner.ensureReaderRole(role);
    } finally {
      await owner.close();
    }
    this.readers.set(appId, { password: role.password, at: Date.now() });
    return as(role.password);
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
