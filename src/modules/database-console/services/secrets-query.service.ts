import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  SECRETS_ENGINE_ADAPTERS,
  SECRETS_PROFILES,
  SecretListEntry,
  SecretRead,
  SecretsConnection,
  SecretsEngine,
  SecretsEngineAdapter,
  SecretsServerInfo,
} from '../engine/secrets-engine';
import {
  SecretsConnectionInfo,
  SecretsResolveInput,
} from '../interfaces/secrets-connection';
import { SecretsConnectionResolver } from './secrets-connection.resolver';
import {
  SecretsBootstrapService,
  UnsealReconcileResult,
} from './secrets-bootstrap.service';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/**
 * Secrets console query service. Same ephemeral-tunnel transport + audit as the
 * other consoles, over the SecretsConnection (OpenBao KV v2). Reads always run;
 * writes (write, delete, destroy) are refused when the request is read-only.
 */
@Injectable()
export class SecretsQueryService {
  private readonly adapters: Map<SecretsEngine, SecretsEngineAdapter>;

  constructor(
    private readonly resolver: SecretsConnectionResolver,
    private readonly bootstrap: SecretsBootstrapService,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(SECRETS_ENGINE_ADAPTERS) adapters: SecretsEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  serverInfo(input: SecretsResolveInput): Promise<SecretsServerInfo> {
    return this.withConnection(input, 'secrets.serverInfo', true, (c) =>
      c.serverInfo(),
    );
  }

  list(input: SecretsResolveInput, prefix: string): Promise<SecretListEntry[]> {
    return this.withConnection(input, 'secrets.list', true, (c) =>
      c.list(prefix),
    );
  }

  read(
    input: SecretsResolveInput,
    path: string,
    version: number | undefined,
  ): Promise<SecretRead | null> {
    return this.withConnection(input, 'secrets.read', true, (c) =>
      c.read(path, version),
    );
  }

  write(
    input: SecretsResolveInput,
    path: string,
    data: Record<string, string>,
    opts: { readOnly: boolean },
  ): Promise<{ version: number }> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 'secrets.write', false, (c) =>
      c.write(path, data),
    );
  }

  remove(
    input: SecretsResolveInput,
    path: string,
    opts: { readOnly: boolean; destroy: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(
      input,
      opts.destroy ? 'secrets.destroy' : 'secrets.delete',
      false,
      (c) => (opts.destroy ? c.destroy(path) : c.deleteLatest(path)),
    );
  }

  undelete(
    input: SecretsResolveInput,
    path: string,
    version: number,
    opts: { readOnly: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withConnection(input, 'secrets.undelete', false, (c) =>
      c.undelete(path, version),
    );
  }

  async connectionInfo(
    input: SecretsResolveInput,
  ): Promise<SecretsConnectionInfo> {
    const resolved = await this.resolver.resolve(input);
    return {
      engine: resolved.engine,
      label: SECRETS_PROFILES[resolved.engine].label,
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
      mount: resolved.mount,
    };
  }

  private assertWritable(readOnly: boolean): void {
    if (readOnly) {
      throw new ForbiddenException(
        'Read-only mode is on — turn it off to change secrets.',
      );
    }
  }

  private adapterFor(engine: SecretsEngine): SecretsEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(
        `Engine "${engine}" is not a secrets server`,
      );
    }
    return adapter;
  }

  private toClientError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    const e = err as {
      clientMessage?: string;
      response?: { data?: { errors?: string[] } };
    };
    if (e?.clientMessage) return new BadRequestException(e.clientMessage);
    const errors = e?.response?.data?.errors;
    if (errors?.length) return new BadRequestException(errors.join('; '));
    return err;
  }

  /**
   * System auto-unseal for one install (used by the reconcile scheduler): open
   * the pooled tunnel, re-unseal from the stored key if sealed, close. No audit —
   * this is a system reconcile, not a user command. Returns the reconcile status.
   */
  async ensureUnsealed(appId: string): Promise<UnsealReconcileResult> {
    const resolved = await this.resolver.resolve({
      appId,
      fluiUserId: 'system',
    });
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
      return await this.bootstrap.reconcileUnseal(resolved, tunnel.localPort);
    } finally {
      await tunnel.dispose();
    }
  }

  private async withConnection<T>(
    input: SecretsResolveInput,
    command: string,
    readOnly: boolean,
    fn: (conn: SecretsConnection) => Promise<T>,
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
      // Lazily initialise/unseal/mount and obtain the access token — all inside
      // this module, no coupling into the catalog installer.
      const token = await this.bootstrap.ensureReady(
        resolved,
        tunnel.localPort,
      );
      const conn = await adapter.connect({
        host: '127.0.0.1',
        port: tunnel.localPort,
        token,
        useTls: resolved.useTls,
        mount: resolved.mount,
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
