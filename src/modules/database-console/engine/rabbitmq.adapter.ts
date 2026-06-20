import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
  CreateStreamInput,
  JsStream,
  MessagingConnectParams,
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
} from './messaging-engine';

// The default vhost is "/", which has to be percent-encoded in every path.
const VHOST = encodeURIComponent('/');
// Built-in durable topic exchange. NATS-style subjects (orders.>, metrics.*)
// map onto its routing patterns, so a queue bound here behaves like a stream
// that "captures" subjects.
const TOPIC_EXCHANGE = 'amq.topic';

interface RmqOverview {
  cluster_name?: string;
  rabbitmq_version?: string;
  product_version?: string;
  object_totals?: { connections?: number; queues?: number; messages?: number };
  message_stats?: { publish?: number; deliver_get?: number };
}

interface RmqNode {
  mem_used?: number;
  processors?: number;
  uptime?: number;
  rabbitmq_version?: string;
}

interface RmqQueue {
  name: string;
  vhost: string;
  durable?: boolean;
  messages?: number;
  message_bytes?: number;
  consumers?: number;
}

interface RmqBinding {
  source?: string;
  destination?: string;
  destination_type?: string;
  routing_key?: string;
}

interface RmqGetMessage {
  payload: string;
  payload_encoding: string;
  routing_key: string;
  properties?: { headers?: Record<string, unknown> };
}

// NATS subject wildcards → AMQP topic wildcards: ">" (rest of subject) maps to
// "#" (zero+ words); "*" (one token) is identical in both. The reverse renders
// a stored binding back as a subject for display.
function subjectToPattern(subject: string): string {
  return subject
    .split('.')
    .map((t) => (t === '>' ? '#' : t))
    .join('.');
}

function patternToSubject(pattern: string): string {
  return pattern
    .split('.')
    .map((t) => (t === '#' ? '>' : t))
    .join('.');
}

function humanizeUptime(ms?: number): string {
  if (!ms || ms < 0) return '';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '<1m';
}

function mapHeaders(
  headers?: Record<string, unknown>,
): Record<string, string[]> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    // AMQP header values are JSON-serializable (string/number/bool/array/table).
    out[k] = [typeof v === 'string' ? v : (JSON.stringify(v) ?? '')];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * RabbitMQ monitoring view over the management HTTP API: server stats from
 * /api/overview + /api/nodes, and queues (rendered as the engine-neutral
 * "streams") with their topic bindings as subjects.
 */
class RabbitMqMonitorConnection implements MessagingConnection {
  constructor(private readonly http: AxiosInstance) {}

  async serverInfo(): Promise<MessagingServerInfo> {
    const [ov, nodes, queues] = await Promise.all([
      this.http.get<RmqOverview>('/api/overview').then((r) => r.data),
      this.http.get<RmqNode[]>('/api/nodes').then((r) => r.data),
      this.http
        .get<RmqQueue[]>(`/api/queues/${VHOST}`, {
          // enable_queue_totals forces message counts even right after a queue
          // is declared, before the stats collector has aggregated them.
          params: {
            columns: 'messages,message_bytes',
            enable_queue_totals: true,
          },
        })
        .then((r) => r.data),
    ]);
    const node = nodes?.[0] ?? {};
    const storageBytes = (queues ?? []).reduce(
      (a, q) => a + (q.message_bytes ?? 0),
      0,
    );
    return {
      serverName: ov.cluster_name ?? 'rabbitmq',
      version:
        ov.rabbitmq_version ??
        ov.product_version ??
        node.rabbitmq_version ??
        'unknown',
      uptime: humanizeUptime(node.uptime),
      connections: ov.object_totals?.connections ?? 0,
      inMsgs: ov.message_stats?.publish ?? 0,
      outMsgs: ov.message_stats?.deliver_get ?? 0,
      inBytes: 0,
      outBytes: 0,
      memBytes: node.mem_used ?? 0,
      cores: node.processors ?? 0,
      jetStream: {
        enabled: true,
        memoryBytes: node.mem_used ?? 0,
        storageBytes,
        accounts: ov.object_totals?.queues ?? 0,
        apiTotal: ov.object_totals?.messages ?? 0,
        apiErrors: 0,
      },
    };
  }

  async streams(): Promise<JsStream[]> {
    const [queues, bindings] = await Promise.all([
      this.http
        .get<RmqQueue[]>(`/api/queues/${VHOST}`, {
          params: { enable_queue_totals: true },
        })
        .then((r) => r.data),
      this.http.get<RmqBinding[]>(`/api/bindings/${VHOST}`).then((r) => r.data),
    ]);
    const subjectsByQueue = new Map<string, string[]>();
    for (const b of bindings ?? []) {
      if (b.destination_type !== 'queue' || b.source !== TOPIC_EXCHANGE)
        continue;
      const dest = b.destination ?? '';
      const arr = subjectsByQueue.get(dest) ?? [];
      arr.push(patternToSubject(b.routing_key ?? ''));
      subjectsByQueue.set(dest, arr);
    }
    return (queues ?? [])
      .map((q) => ({
        name: q.name,
        account: q.vhost,
        subjects: subjectsByQueue.get(q.name) ?? [q.name],
        retention: q.durable ? 'durable' : 'transient',
        storage: q.durable ? 'durable' : 'transient',
        messages: q.messages ?? 0,
        bytes: q.message_bytes ?? 0,
        firstSeq: 0,
        lastSeq: 0,
        consumerCount: q.consumers ?? 0,
        consumers: [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * RabbitMQ produce/peek + queue management over the management HTTP API.
 * Publish goes through the topic exchange (routed by subject); peek uses a
 * requeueing get so reading never consumes; createStream declares a durable
 * queue and binds it to the topic exchange for each subject.
 */
class RabbitMqProtocolConnection implements MessagingProtocolConnection {
  constructor(private readonly http: AxiosInstance) {}

  async publish(target: PublishTarget): Promise<PublishResult> {
    const { data } = await this.http.post<{ routed?: boolean }>(
      `/api/exchanges/${VHOST}/${TOPIC_EXCHANGE}/publish`,
      {
        properties:
          target.headers && Object.keys(target.headers).length
            ? { headers: target.headers }
            : {},
        routing_key: target.subject,
        payload: target.payload ?? '',
        payload_encoding: 'string',
      },
    );
    if (!data?.routed) {
      const msg = `No queue is bound to capture "${target.subject}". Create a queue with a matching binding (Streams panel), then publish.`;
      throw Object.assign(new Error(msg), { clientMessage: msg });
    }
    return { stream: target.subject };
  }

  async peek(opts: PeekOptions): Promise<QueueMessage[]> {
    const { data } = await this.http.post<RmqGetMessage[]>(
      `/api/queues/${VHOST}/${encodeURIComponent(opts.stream)}/get`,
      {
        count: opts.limit,
        // Read without consuming — messages are returned to the queue.
        ackmode: 'reject_requeue_true',
        encoding: 'auto',
        truncate: 50000,
      },
    );
    return (data ?? []).map((m, i) => ({
      seq: i + 1,
      subject: m.routing_key,
      data: m.payload,
      encoding: m.payload_encoding === 'base64' ? 'base64' : 'utf8',
      headers: mapHeaders(m.properties?.headers),
    }));
  }

  async listStreams(): Promise<QueueStream[]> {
    const [queues, bindings] = await Promise.all([
      this.http
        .get<RmqQueue[]>(`/api/queues/${VHOST}`, {
          params: { enable_queue_totals: true },
        })
        .then((r) => r.data),
      this.http.get<RmqBinding[]>(`/api/bindings/${VHOST}`).then((r) => r.data),
    ]);
    const subjectsByQueue = new Map<string, string[]>();
    for (const b of bindings ?? []) {
      if (b.destination_type !== 'queue' || b.source !== TOPIC_EXCHANGE)
        continue;
      const dest = b.destination ?? '';
      const arr = subjectsByQueue.get(dest) ?? [];
      arr.push(patternToSubject(b.routing_key ?? ''));
      subjectsByQueue.set(dest, arr);
    }
    return (queues ?? [])
      .map((q) => this.toQueueStream(q, subjectsByQueue.get(q.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createStream(spec: CreateStreamInput): Promise<QueueStream> {
    const args: Record<string, number> = {};
    if (spec.maxMsgs) args['x-max-length'] = spec.maxMsgs;
    if (spec.maxBytes) args['x-max-length-bytes'] = spec.maxBytes;
    if (spec.maxAgeSeconds) args['x-message-ttl'] = spec.maxAgeSeconds * 1000;
    // Always durable: RabbitMQ 4.x deprecated transient (non-durable) queues, so
    // the NATS file/memory storage axis doesn't apply — queues persist.
    await this.http.put(
      `/api/queues/${VHOST}/${encodeURIComponent(spec.name)}`,
      {
        durable: true,
        auto_delete: false,
        arguments: args,
      },
    );
    const subjects = spec.subjects.length ? spec.subjects : [spec.name];
    for (const subject of subjects) {
      await this.http.post(
        `/api/bindings/${VHOST}/e/${TOPIC_EXCHANGE}/q/${encodeURIComponent(spec.name)}`,
        { routing_key: subjectToPattern(subject), arguments: {} },
      );
    }
    const { data } = await this.http.get<RmqQueue>(
      `/api/queues/${VHOST}/${encodeURIComponent(spec.name)}`,
    );
    return this.toQueueStream(data, subjects);
  }

  async deleteStream(name: string): Promise<void> {
    await this.http.delete(`/api/queues/${VHOST}/${encodeURIComponent(name)}`);
  }

  private toQueueStream(q: RmqQueue, subjects?: string[]): QueueStream {
    return {
      name: q.name,
      subjects: subjects?.length ? subjects : [q.name],
      storage: q.durable ? 'durable' : 'transient',
      retention: q.durable ? 'durable' : 'transient',
      messages: q.messages ?? 0,
      bytes: q.message_bytes ?? 0,
      firstSeq: 0,
      lastSeq: 0,
      consumerCount: q.consumers ?? 0,
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * RabbitMQ adapter. Both the monitoring and protocol sessions speak the
 * management HTTP API (:15672) with the broker's owner credentials over the
 * port-forward — stats, queue/binding management, publish and non-destructive
 * get all live there, so no AMQP client is needed.
 */
@Injectable()
export class RabbitMqAdapter implements MessagingEngineAdapter {
  readonly engines: MessagingEngine[] = ['rabbitmq'];

  connect(params: MessagingConnectParams): Promise<MessagingConnection> {
    return Promise.resolve(new RabbitMqMonitorConnection(this.client(params)));
  }

  connectProtocol(
    params: MessagingConnectParams,
  ): Promise<MessagingProtocolConnection> {
    return Promise.resolve(new RabbitMqProtocolConnection(this.client(params)));
  }

  private client(params: MessagingConnectParams): AxiosInstance {
    return axios.create({
      baseURL: `http://${params.host}:${params.port}`,
      timeout: 15_000,
      auth:
        params.username && params.password
          ? { username: params.username, password: params.password }
          : undefined,
    });
  }
}
