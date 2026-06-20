import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  CreateStreamInput,
  JsStream,
  MessagingConnection,
  MessagingEngine,
  MessagingEngineAdapter,
  MessagingProtocolConnection,
  MessagingServerInfo,
  PeekOptions,
  PublishResult,
  PublishTarget,
  QueueMessage,
  QueueStream,
  MESSAGING_ENGINE_ADAPTERS,
  MESSAGING_PROFILES,
} from '../engine/messaging-engine';
import {
  MessagingConnectionInfo,
  MessagingResolveInput,
} from '../interfaces/messaging-connection';
import { MessagingConnectionResolver } from './messaging-connection.resolver';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/**
 * Read-only messaging monitor query service. Same ephemeral-tunnel transport and
 * audit as the other consoles, speaking the MessagingConnection contract over
 * the server's monitoring API. Observability only — never publishes or mutates.
 */
@Injectable()
export class MessagingQueryService {
  private readonly adapters: Map<MessagingEngine, MessagingEngineAdapter>;

  constructor(
    private readonly resolver: MessagingConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    @Inject(MESSAGING_ENGINE_ADAPTERS)
    adapters: MessagingEngineAdapter[],
    private readonly audit: DbConsoleAuditService,
  ) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      for (const engine of adapter.engines) this.adapters.set(engine, adapter);
    }
  }

  serverInfo(input: MessagingResolveInput): Promise<MessagingServerInfo> {
    return this.withConnection(input, 'messaging.serverInfo', (c) =>
      c.serverInfo(),
    );
  }

  streams(input: MessagingResolveInput): Promise<JsStream[]> {
    return this.withConnection(input, 'messaging.streams', (c) => c.streams());
  }

  /** Produce a message to a subject (gated write). */
  publish(
    input: MessagingResolveInput,
    target: PublishTarget,
    opts: { readOnly: boolean },
  ): Promise<PublishResult> {
    this.assertWritable(opts.readOnly);
    return this.withProtocol(input, 'messaging.publish', false, (c) =>
      c.publish(target),
    );
  }

  /** Non-destructive peek of recent stored messages from a stream. */
  peek(
    input: MessagingResolveInput,
    opts: PeekOptions,
  ): Promise<QueueMessage[]> {
    return this.withProtocol(input, 'messaging.peek', true, (c) =>
      c.peek(opts),
    );
  }

  /** Create a stream covering one or more subjects (gated write). */
  createStream(
    input: MessagingResolveInput,
    spec: CreateStreamInput,
    opts: { readOnly: boolean },
  ): Promise<QueueStream> {
    this.assertWritable(opts.readOnly);
    return this.withProtocol(input, 'messaging.createStream', false, (c) =>
      c.createStream(spec),
    );
  }

  /** Delete a stream and its stored messages (gated destructive write). */
  deleteStream(
    input: MessagingResolveInput,
    name: string,
    opts: { readOnly: boolean },
  ): Promise<void> {
    this.assertWritable(opts.readOnly);
    return this.withProtocol(input, 'messaging.deleteStream', false, (c) =>
      c.deleteStream(name),
    );
  }

  private assertWritable(readOnly: boolean): void {
    if (readOnly) {
      throw new ForbiddenException(
        'Read-only mode is on — turn it off to publish or manage streams.',
      );
    }
  }

  async connectionInfo(
    input: MessagingResolveInput,
  ): Promise<MessagingConnectionInfo> {
    const resolved = await this.resolver.resolve(input);
    return {
      engine: resolved.engine,
      label: MESSAGING_PROFILES[resolved.engine].label,
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
    };
  }

  /**
   * Turn an actionable broker error into a readable 400 instead of a blank 500.
   * NATS surfaces JetStream API errors with an `api_error.description` (e.g.
   * "subjects overlap with an existing stream", "stream not found"); a publish to
   * a subject no stream captures comes back as a bare code "503". RabbitMQ's
   * management API returns `{ reason | error }` (and adapters raise a
   * `clientMessage` for cases they detect themselves, like an unrouted publish).
   * Genuine/unknown errors (connection, timeout) are left to surface as 500.
   */
  private toClientError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    const e = err as {
      api_error?: { description?: string };
      code?: string;
      clientMessage?: string;
      response?: { data?: { reason?: string; error?: string } };
    };
    if (e?.clientMessage) return new BadRequestException(e.clientMessage);
    if (e?.api_error?.description) {
      return new BadRequestException(e.api_error.description);
    }
    if (e?.code === '503') {
      return new BadRequestException(
        'No stream captures this subject — create a stream for it first (Streams panel), then publish.',
      );
    }
    const data = e?.response?.data;
    const reason = data?.reason ?? data?.error;
    if (reason) return new BadRequestException(String(reason));
    return err;
  }

  private adapterFor(engine: MessagingEngine): MessagingEngineAdapter {
    const adapter = this.adapters.get(engine);
    if (!adapter) {
      throw new BadRequestException(
        `Engine "${engine}" is not a messaging server`,
      );
    }
    return adapter;
  }

  /** Same ephemeral-tunnel + audit lifecycle as withConnection, but over the
   * client/protocol port and the protocol adapter (publish/peek). */
  private async withProtocol<T>(
    input: MessagingResolveInput,
    command: string,
    readOnly: boolean,
    fn: (conn: MessagingProtocolConnection) => Promise<T>,
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
      resolved.target.clientPort,
    );
    try {
      const conn = await adapter.connectProtocol({
        host: '127.0.0.1',
        port: tunnel.localPort,
        username: resolved.credentials?.username,
        password: resolved.credentials?.password,
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

  private async withConnection<T>(
    input: MessagingResolveInput,
    command: string,
    fn: (conn: MessagingConnection) => Promise<T>,
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
        username: resolved.credentials?.username,
        password: resolved.credentials?.password,
      });
      try {
        const result = await fn(conn);
        this.audit.emit({
          dbInstallId: input.appId,
          userId: input.fluiUserId,
          role: 'owner',
          command,
          rowCount: 0,
          readOnly: true,
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
        readOnly: true,
        durationMs: Date.now() - started,
        failed: true,
      });
      throw this.toClientError(err);
    } finally {
      await tunnel.dispose();
    }
  }
}
