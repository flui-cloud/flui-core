import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  DbConnectionResolveInput,
  DbConnectionResolver,
  DbEngine,
  DB_CONNECTION_RESOLVER,
  ResolvedDbConnection,
} from '../interfaces/db-connection';
import {
  CommandResult,
  KV_ENGINE_ADAPTERS,
  KeyValueConnection,
  KeyValueEngineAdapter,
  KeyValueRead,
  KeyspaceSummary,
  ScanResult,
} from '../engine/keyvalue-engine';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

const MAX_ELEMENTS = 1000;

/**
 * Key-value counterpart to DbQueryService: same transport (ephemeral tunnel) and resolver
 * seam, but it speaks the KeyValueEngineAdapter contract (keyspace browse + command) instead
 * of SQL. Browse operations are reads; arbitrary commands go through the read-only gate.
 */
@Injectable()
export class KvQueryService {
  private readonly adapters: Map<DbEngine, KeyValueEngineAdapter>;

  constructor(
    @Inject(DB_CONNECTION_RESOLVER)
    private readonly connectionResolver: DbConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(KV_ENGINE_ADAPTERS)
    kvAdapters: KeyValueEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of kvAdapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  summary(input: DbConnectionResolveInput): Promise<KeyspaceSummary> {
    return this.withConnection(input, (conn) => conn.summary());
  }

  scan(
    input: DbConnectionResolveInput,
    opts: { cursor: string; match?: string; count: number },
  ): Promise<ScanResult> {
    return this.withConnection(input, (conn) => conn.scan(opts));
  }

  readKey(input: DbConnectionResolveInput, key: string): Promise<KeyValueRead> {
    return this.withConnection(input, (conn) =>
      conn.readKey(key, { maxElements: MAX_ELEMENTS }),
    );
  }

  async runCommand(
    input: DbConnectionResolveInput,
    args: (string | number)[],
    readOnly: boolean,
  ): Promise<CommandResult> {
    return this.withConnection(input, async (conn, resolved) => {
      const name = String(args[0] ?? '').toUpperCase();
      try {
        const result = await conn.command(args, { readOnly });
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

  private adapterFor(engine: DbEngine): KeyValueEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(
        `Application engine "${engine}" is not a key-value store`,
      );
    }
    return adapter;
  }

  private async withConnection<T>(
    input: DbConnectionResolveInput,
    fn: (
      conn: KeyValueConnection,
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
    } finally {
      await tunnel.dispose();
    }
  }
}
