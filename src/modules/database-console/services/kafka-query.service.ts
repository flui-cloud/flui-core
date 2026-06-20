import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  CommandResult,
  CommandParseError,
  KafkaClient,
  TopicSummary,
  GroupSummary,
  ClusterInfo,
  executeCommand,
  parseCommand,
} from '../../../kafka-client';
import { KAFKA_PROFILES } from '../engine/kafka-engine';
import {
  KafkaConnectionInfo,
  KafkaResolveInput,
} from '../interfaces/kafka-connection';
import { KafkaConnectionResolver } from './kafka-connection.resolver';
import { KafkaAdapter } from '../engine/kafka.adapter';
import { KubePortForwardService } from './kube-port-forward.service';
import { DbConsoleAuditService } from './db-console-audit.service';

/**
 * Kafka console query service. Same tunnel + audit lifecycle as the other
 * consoles, but the protocol session is the standalone Kafka client library
 * pinned to the tunnel. Commands are parsed from kafka-shell; writes are gated by
 * the request's read-only flag.
 */
@Injectable()
export class KafkaQueryService {
  constructor(
    private readonly resolver: KafkaConnectionResolver,
    private readonly portForward: KubePortForwardService,
    private readonly clusters: ClustersService,
    private readonly adapter: KafkaAdapter,
    private readonly audit: DbConsoleAuditService,
  ) {}

  /** Parse, gate writes, then execute one kafka-shell command. */
  async runCommand(
    input: KafkaResolveInput,
    command: string,
    opts: { readOnly: boolean },
  ): Promise<CommandResult> {
    let parsed;
    try {
      parsed = parseCommand(command);
    } catch (err) {
      if (err instanceof CommandParseError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    if (parsed.mutation && opts.readOnly) {
      throw new ForbiddenException(
        `"${parsed.verb}" changes data and the console is in read-only mode. Disable read-only to run it.`,
      );
    }
    return this.withClient(
      input,
      `kafka.${parsed.verb}`,
      !parsed.mutation,
      (c) => executeCommand(c, parsed),
    );
  }

  topics(input: KafkaResolveInput): Promise<TopicSummary[]> {
    return this.withClient(input, 'kafka.topics', true, (c) => c.listTopics());
  }

  groups(input: KafkaResolveInput): Promise<GroupSummary[]> {
    return this.withClient(input, 'kafka.groups', true, (c) => c.listGroups());
  }

  clusterInfo(input: KafkaResolveInput): Promise<ClusterInfo> {
    return this.withClient(input, 'kafka.cluster', true, (c) =>
      c.clusterInfo(),
    );
  }

  async connectionInfo(input: KafkaResolveInput): Promise<KafkaConnectionInfo> {
    const resolved = await this.resolver.resolve(input);
    return {
      engine: resolved.engine,
      label: KAFKA_PROFILES[resolved.engine].label,
      namespace: resolved.target.namespace,
      podLabelSelector: resolved.target.podLabelSelector,
      clusterId: resolved.target.clusterId,
      remotePort: resolved.target.port,
    };
  }

  private async withClient<T>(
    input: KafkaResolveInput,
    command: string,
    readOnly: boolean,
    fn: (client: KafkaClient) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const resolved = await this.resolver.resolve(input);
    const kubeconfig = await this.clusters.getKubeconfig(
      resolved.target.clusterId,
    );
    const tunnel = await this.portForward.open(
      kubeconfig,
      resolved.target.namespace,
      resolved.target.podLabelSelector,
      resolved.target.port,
    );
    const client = this.adapter.connect({
      host: '127.0.0.1',
      port: tunnel.localPort,
      sasl: resolved.sasl,
    });
    try {
      const result = await fn(client);
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
      await client.close().catch(() => undefined);
      await tunnel.dispose();
    }
  }

  /**
   * Turn an actionable Kafka/kafkajs error into a readable 400. kafkajs raises
   * `KafkaJS*` errors with a descriptive `.message` (unknown topic, invalid
   * partition, policy violations); surface those instead of an opaque 500.
   * Connection/timeout faults are left to surface as 500.
   */
  private toClientError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    const e = err as { name?: string; message?: string };
    if (e?.name && e.name.startsWith('KafkaJS') && e.message) {
      return new BadRequestException(e.message);
    }
    return err;
  }
}
