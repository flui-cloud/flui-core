import {
  Admin,
  ConfigResourceTypes,
  ISocketFactory,
  Kafka,
  KafkaMessage,
  Producer,
  SASLOptions,
  logLevel,
} from 'kafkajs';
import {
  ClusterInfo,
  ConsumeSpec,
  ConsumedMessage,
  CreateTopicSpec,
  GroupDescription,
  GroupLag,
  GroupSummary,
  PartitionLag,
  ProduceResult,
  ProduceSpec,
  TopicDetail,
  TopicSummary,
} from './types';

export interface KafkaClientOptions {
  /** Bootstrap broker list. With a custom socketFactory the addresses are placeholders. */
  brokers: string[];
  clientId?: string;
  /**
   * Inject the socket layer. This is how the host decouples transport from the
   * client: e.g. route every broker connection through a tunnel regardless of the
   * advertised address. When omitted, kafkajs connects to `brokers` directly
   * (normal multi-broker operation).
   */
  socketFactory?: ISocketFactory;
  ssl?: boolean | object;
  sasl?: SASLOptions;
  connectionTimeout?: number;
  requestTimeout?: number;
}

function decodeBuffer(buf: Buffer | null): {
  text: string | null;
  encoding: 'utf8' | 'base64';
} {
  if (buf === null || buf === undefined)
    return { text: null, encoding: 'utf8' };
  const utf8 = buf.toString('utf8');
  if (Buffer.from(utf8, 'utf8').equals(buf))
    return { text: utf8, encoding: 'utf8' };
  return { text: buf.toString('base64'), encoding: 'base64' };
}

function isoTs(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString();
}

/**
 * A multi-broker Kafka client over kafkajs, exposing the higher-level operations
 * the console needs. Transport-agnostic: pass a `socketFactory` to control how
 * sockets are opened (tunnels, proxies, …). No Kubernetes or Flui awareness.
 */
export class KafkaClient {
  private readonly kafka: Kafka;
  private _admin?: Admin;
  private adminUp = false;
  private _producer?: Producer;
  private producerUp = false;

  constructor(opts: KafkaClientOptions) {
    this.kafka = new Kafka({
      clientId: opts.clientId ?? 'flui-kafka-console',
      brokers: opts.brokers,
      socketFactory: opts.socketFactory,
      ssl: opts.ssl,
      sasl: opts.sasl,
      connectionTimeout: opts.connectionTimeout ?? 10_000,
      requestTimeout: opts.requestTimeout ?? 20_000,
      enforceRequestTimeout: true,
      retry: { retries: 2, initialRetryTime: 200 },
      logLevel: logLevel.NOTHING,
    });
  }

  private async admin(): Promise<Admin> {
    if (!this._admin) this._admin = this.kafka.admin();
    if (!this.adminUp) {
      await this._admin.connect();
      this.adminUp = true;
    }
    return this._admin;
  }

  private async producer(): Promise<Producer> {
    if (!this._producer) this._producer = this.kafka.producer();
    if (!this.producerUp) {
      await this._producer.connect();
      this.producerUp = true;
    }
    return this._producer;
  }

  async clusterInfo(): Promise<ClusterInfo> {
    const admin = await this.admin();
    const c = await admin.describeCluster();
    return {
      clusterId: c.clusterId,
      controllerId: c.controller ?? undefined,
      brokers: c.brokers.map((b) => ({
        nodeId: b.nodeId,
        host: b.host,
        port: b.port,
      })),
    };
  }

  async listTopics(): Promise<TopicSummary[]> {
    const admin = await this.admin();
    const names = await admin.listTopics();
    if (!names.length) return [];
    const meta = await admin.fetchTopicMetadata({ topics: names });
    return meta.topics
      .map((t) => ({
        name: t.name,
        partitions: t.partitions.length,
        replicationFactor: t.partitions[0]?.replicas.length ?? 0,
        internal: t.name.startsWith('__'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTopic(name: string): Promise<TopicDetail> {
    const admin = await this.admin();
    const meta = await admin.fetchTopicMetadata({ topics: [name] });
    const t = meta.topics[0];
    if (!t) throw new Error(`Topic "${name}" not found.`);
    const offsets = await admin.fetchTopicOffsets(name);
    const offByPart = new Map(offsets.map((o) => [o.partition, o]));
    const partitions = t.partitions.map((p) => {
      const o = offByPart.get(p.partitionId);
      return {
        partition: p.partitionId,
        leader: p.leader,
        replicas: p.replicas,
        isr: p.isr,
        low: o?.low,
        high: o?.high,
      };
    });
    let configs: TopicDetail['configs'] = [];
    try {
      const cfg = await admin.describeConfigs({
        includeSynonyms: false,
        resources: [{ type: ConfigResourceTypes.TOPIC, name }],
      });
      configs = (cfg.resources[0]?.configEntries ?? []).map((e) => ({
        name: e.configName,
        value: e.configValue,
        isDefault: Boolean(e.isDefault),
      }));
    } catch {
      // describeConfigs may be denied; partitions are the essential view.
    }
    return { name, partitions, configs };
  }

  async createTopic(spec: CreateTopicSpec): Promise<{ created: boolean }> {
    const admin = await this.admin();
    const created = await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: spec.topic,
          numPartitions: spec.numPartitions ?? 1,
          replicationFactor: spec.replicationFactor ?? 1,
        },
      ],
    });
    return { created };
  }

  async deleteTopic(name: string): Promise<void> {
    const admin = await this.admin();
    await admin.deleteTopics({ topics: [name] });
  }

  async produce(spec: ProduceSpec): Promise<ProduceResult> {
    const producer = await this.producer();
    const res = await producer.send({
      topic: spec.topic,
      messages: [
        {
          key: spec.key ?? null,
          value: spec.value,
          partition: spec.partition,
        },
      ],
    });
    const r = res[0];
    return {
      topic: spec.topic,
      partition: r?.partition ?? spec.partition ?? 0,
      offset: r?.offset ?? r?.baseOffset,
    };
  }

  async listGroups(): Promise<GroupSummary[]> {
    const admin = await this.admin();
    const res = await admin.listGroups();
    return res.groups
      .map((g) => ({ groupId: g.groupId, protocolType: g.protocolType }))
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
  }

  async describeGroup(groupId: string): Promise<GroupDescription> {
    const admin = await this.admin();
    const res = await admin.describeGroups([groupId]);
    const g = res.groups[0];
    if (!g) throw new Error(`Group "${groupId}" not found.`);
    return {
      groupId: g.groupId,
      state: g.state,
      protocol: g.protocol,
      members: g.members.map((m) => ({
        memberId: m.memberId,
        clientId: m.clientId,
        host: m.clientHost,
      })),
    };
  }

  async groupLag(groupId: string): Promise<GroupLag> {
    const admin = await this.admin();
    const committed = await admin.fetchOffsets({ groupId });
    const partitions: PartitionLag[] = [];
    let totalLag = 0;
    for (const topic of committed) {
      const watermarks = await admin.fetchTopicOffsets(topic.topic);
      const highByPart = new Map(watermarks.map((w) => [w.partition, w]));
      for (const p of topic.partitions) {
        const wm = highByPart.get(p.partition);
        const high = BigInt(wm?.high ?? '0');
        const low = BigInt(wm?.low ?? '0');
        const current = p.offset;
        // offset '-1' means the group never committed for this partition.
        const consumed = current === '-1' ? low : BigInt(current);
        const lag = Number(high - consumed);
        const clamped = Math.max(0, lag);
        totalLag += clamped;
        partitions.push({
          topic: topic.topic,
          partition: p.partition,
          current,
          logEnd: high.toString(),
          lag: clamped,
        });
      }
    }
    partitions.sort(
      (a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition,
    );
    return { groupId, totalLag, partitions };
  }

  /**
   * Read recent records without committing — non-destructive. Uses a throwaway
   * consumer group and seeks each partition to the requested window, so it never
   * disturbs real consumers' offsets. Best-effort deletes the throwaway group.
   */
  async consume(spec: ConsumeSpec): Promise<ConsumedMessage[]> {
    const limit = spec.limit ?? spec.fromEnd ?? spec.fromStart ?? 20;
    const idleMs = spec.idleMs ?? 3000;
    const admin = await this.admin();
    const all = await admin.fetchTopicOffsets(spec.topic);
    let parts = all.map((p) => ({
      partition: p.partition,
      low: BigInt(p.low),
      high: BigInt(p.high),
    }));
    if (spec.partition !== undefined) {
      parts = parts.filter((p) => p.partition === spec.partition);
    }

    const starts = new Map<number, bigint>();
    for (const p of parts) {
      if (p.high <= p.low) continue; // empty partition
      let start: bigint;
      if (spec.fromStart === undefined) {
        const n = BigInt(spec.fromEnd ?? limit);
        start = p.high - n;
        if (start < p.low) start = p.low;
      } else {
        start = p.low;
      }
      starts.set(p.partition, start);
    }
    if (!starts.size) return [];

    const groupId = `flui-peek-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const consumer = this.kafka.consumer({
      groupId,
      allowAutoTopicCreation: false,
    });
    const collected: ConsumedMessage[] = [];

    await consumer.connect();
    await consumer.subscribe({
      topic: spec.topic,
      fromBeginning: spec.fromStart !== undefined,
    });

    await new Promise<void>((resolve) => {
      let idle: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(idle);
        resolve();
      };
      const bump = () => {
        clearTimeout(idle);
        idle = setTimeout(finish, idleMs);
        idle.unref?.();
      };
      bump();
      void consumer
        .run({
          autoCommit: false,
          eachMessage: async ({
            partition,
            message,
          }: {
            partition: number;
            message: KafkaMessage;
          }) => {
            const start = starts.get(partition);
            if (start === undefined || BigInt(message.offset) < start) return;
            const v = decodeBuffer(message.value);
            const k = decodeBuffer(message.key);
            collected.push({
              topic: spec.topic,
              partition,
              offset: message.offset,
              key: k.text,
              value: v.text,
              encoding: v.encoding,
              timestamp: isoTs(message.timestamp),
            });
            bump();
            if (collected.length >= limit) finish();
          },
        })
        .then(() => {
          for (const [partition, start] of starts) {
            consumer.seek({
              topic: spec.topic,
              partition,
              offset: start.toString(),
            });
          }
        });
    });

    await consumer.stop().catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
    void admin.deleteGroups([groupId]).catch(() => undefined);

    collected.sort(
      (a, b) =>
        a.partition - b.partition ||
        Number(BigInt(a.offset) - BigInt(b.offset)),
    );
    return collected.slice(0, limit);
  }

  async close(): Promise<void> {
    if (this.adminUp && this._admin) {
      await this._admin.disconnect().catch(() => undefined);
      this.adminUp = false;
    }
    if (this.producerUp && this._producer) {
      await this._producer.disconnect().catch(() => undefined);
      this.producerUp = false;
    }
  }
}
