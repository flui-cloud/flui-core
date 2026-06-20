import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
  connect,
  headers as natsHeaders,
  nanos,
  NatsConnection,
  RetentionPolicy,
  StorageType,
} from 'nats';
import {
  CreateStreamInput,
  JsConsumer,
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

interface VarzResponse {
  server_name?: string;
  version?: string;
  uptime?: string;
  connections?: number;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  mem?: number;
  cores?: number;
  jetstream?: {
    stats?: {
      memory?: number;
      storage?: number;
      accounts?: number;
      api?: { total?: number; errors?: number };
    };
  };
}

interface JszConsumer {
  name?: string;
  stream_name?: string;
  config?: {
    ack_policy?: string;
    deliver_policy?: string;
    durable_name?: string;
  };
  delivered?: { stream_seq?: number };
  ack_floor?: { stream_seq?: number };
  num_ack_pending?: number;
  num_redelivered?: number;
  num_waiting?: number;
  num_pending?: number;
}

interface JszStream {
  name?: string;
  config?: { subjects?: string[]; retention?: string; storage?: string };
  state?: {
    messages?: number;
    bytes?: number;
    first_seq?: number;
    last_seq?: number;
    consumer_count?: number;
  };
  consumer_detail?: JszConsumer[];
}

interface JszResponse {
  account_details?: Array<{ name?: string; stream_detail?: JszStream[] }>;
}

class NatsMonitorConnection implements MessagingConnection {
  constructor(private readonly http: AxiosInstance) {}

  async serverInfo(): Promise<MessagingServerInfo> {
    const { data } = await this.http.get<VarzResponse>('/varz');
    const stats = data.jetstream?.stats;
    return {
      serverName: data.server_name ?? 'unknown',
      version: data.version ?? 'unknown',
      uptime: data.uptime ?? '',
      connections: data.connections ?? 0,
      inMsgs: data.in_msgs ?? 0,
      outMsgs: data.out_msgs ?? 0,
      inBytes: data.in_bytes ?? 0,
      outBytes: data.out_bytes ?? 0,
      memBytes: data.mem ?? 0,
      cores: data.cores ?? 0,
      jetStream: {
        enabled: !!data.jetstream,
        memoryBytes: stats?.memory ?? 0,
        storageBytes: stats?.storage ?? 0,
        accounts: stats?.accounts ?? 0,
        apiTotal: stats?.api?.total ?? 0,
        apiErrors: stats?.api?.errors ?? 0,
      },
    };
  }

  async streams(): Promise<JsStream[]> {
    const { data } = await this.http.get<JszResponse>('/jsz', {
      params: { accounts: true, streams: true, consumers: true, config: true },
    });
    const out: JsStream[] = [];
    for (const acct of data.account_details ?? []) {
      for (const s of acct.stream_detail ?? []) {
        out.push({
          name: s.name ?? '',
          account: acct.name ?? '',
          subjects: s.config?.subjects ?? [],
          retention: s.config?.retention,
          storage: s.config?.storage,
          messages: s.state?.messages ?? 0,
          bytes: s.state?.bytes ?? 0,
          firstSeq: s.state?.first_seq ?? 0,
          lastSeq: s.state?.last_seq ?? 0,
          consumerCount: s.state?.consumer_count ?? 0,
          consumers: (s.consumer_detail ?? []).map((c) =>
            this.mapConsumer(c, s.name ?? ''),
          ),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private mapConsumer(c: JszConsumer, stream: string): JsConsumer {
    return {
      name: c.name ?? '',
      stream: c.stream_name ?? stream,
      numPending: c.num_pending ?? 0,
      numAckPending: c.num_ack_pending ?? 0,
      numRedelivered: c.num_redelivered ?? 0,
      numWaiting: c.num_waiting ?? 0,
      deliveredStreamSeq: c.delivered?.stream_seq ?? 0,
      ackFloorStreamSeq: c.ack_floor?.stream_seq ?? 0,
      ackPolicy: c.config?.ack_policy,
      deliverPolicy: c.config?.deliver_policy,
      durable: !!c.config?.durable_name,
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// Treat a payload as binary (and base64-encode it) when UTF-8 decoding yields the
// replacement char (U+FFFD) or C0 control bytes other than tab/newline/CR.
function isBinaryText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i);
    if (c === 0xfffd) return true;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}

function decodePayload(data: Uint8Array): {
  data: string;
  encoding: 'utf8' | 'base64';
} {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (isBinaryText(text)) {
    return { data: Buffer.from(data).toString('base64'), encoding: 'base64' };
  }
  return { data: text, encoding: 'utf8' };
}

/**
 * NATS JetStream protocol session: publishes to a subject (stored by whatever
 * stream covers it) and peeks recent stream messages by sequence — a direct,
 * non-destructive read that never acks, so it can't steal delivery from real
 * consumers. Connection is short-lived (one request) with reconnect disabled.
 */
class NatsProtocolConnection implements MessagingProtocolConnection {
  constructor(private readonly nc: NatsConnection) {}

  async publish(target: PublishTarget): Promise<PublishResult> {
    const js = this.nc.jetstream();
    const payload = new TextEncoder().encode(target.payload);
    let opts: { headers?: ReturnType<typeof natsHeaders> } | undefined;
    if (target.headers && Object.keys(target.headers).length) {
      const h = natsHeaders();
      for (const [k, v] of Object.entries(target.headers)) h.set(k, v);
      opts = { headers: h };
    }
    const ack = await js.publish(target.subject, payload, opts);
    return { stream: ack.stream, seq: ack.seq };
  }

  async peek(opts: PeekOptions): Promise<QueueMessage[]> {
    const jsm = await this.nc.jetstreamManager();
    const info = await jsm.streams.info(opts.stream);
    const first = info.state.first_seq;
    const last = info.state.last_seq;
    const out: QueueMessage[] = [];
    let seq = opts.startSeq ?? last;
    if (seq > last) seq = last;
    while (out.length < opts.limit && seq >= first && seq >= 1) {
      try {
        const m = await jsm.streams.getMessage(opts.stream, { seq });
        const decoded = decodePayload(m.data);
        out.push({
          seq: m.seq,
          subject: m.subject,
          data: decoded.data,
          encoding: decoded.encoding,
          timestamp: m.time ? new Date(m.time).toISOString() : undefined,
          headers: this.mapHeaders(m.header),
        });
      } catch {
        // sequence was deleted/purged — skip it and keep walking back.
      }
      seq--;
    }
    return out;
  }

  async listStreams(): Promise<QueueStream[]> {
    const jsm = await this.nc.jetstreamManager();
    const out: QueueStream[] = [];
    for await (const si of jsm.streams.list()) out.push(toQueueStream(si));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createStream(spec: CreateStreamInput): Promise<QueueStream> {
    const jsm = await this.nc.jetstreamManager();
    const si = await jsm.streams.add({
      name: spec.name,
      subjects: spec.subjects,
      storage:
        spec.storage === 'memory' ? StorageType.Memory : StorageType.File,
      retention: (spec.retention as RetentionPolicy) ?? RetentionPolicy.Limits,
      ...(spec.maxMsgs ? { max_msgs: spec.maxMsgs } : {}),
      ...(spec.maxBytes ? { max_bytes: spec.maxBytes } : {}),
      ...(spec.maxAgeSeconds
        ? { max_age: nanos(spec.maxAgeSeconds * 1000) }
        : {}),
    });
    return toQueueStream(si);
  }

  async deleteStream(name: string): Promise<void> {
    const jsm = await this.nc.jetstreamManager();
    await jsm.streams.delete(name);
  }

  private mapHeaders(
    h: { keys(): string[]; values(k: string): string[] } | undefined,
  ): Record<string, string[]> | undefined {
    if (!h) return undefined;
    const out: Record<string, string[]> = {};
    for (const k of h.keys()) out[k] = h.values(k);
    return Object.keys(out).length ? out : undefined;
  }

  async close(): Promise<void> {
    await this.nc.close();
  }
}

// NATS StreamInfo → engine-neutral QueueStream (config + current state).
function toQueueStream(si: {
  config: {
    name: string;
    subjects?: string[];
    storage?: string;
    retention?: string;
  };
  state: {
    messages?: number;
    bytes?: number;
    first_seq?: number;
    last_seq?: number;
    consumer_count?: number;
  };
}): QueueStream {
  return {
    name: si.config.name,
    subjects: si.config.subjects ?? [],
    storage: si.config.storage,
    retention: si.config.retention,
    messages: si.state.messages ?? 0,
    bytes: si.state.bytes ?? 0,
    firstSeq: si.state.first_seq ?? 0,
    lastSeq: si.state.last_seq ?? 0,
    consumerCount: si.state.consumer_count ?? 0,
  };
}

/**
 * NATS adapter. Monitoring (`connect`) reads the HTTP API (/varz, /jsz) for stats
 * and stream/consumer topology. Protocol (`connectProtocol`) opens a short-lived
 * JetStream client on the client port to publish and to peek stored messages.
 * Both run over the port-forward; the tunnel is the security boundary (the
 * in-cluster server is unauthenticated).
 */
@Injectable()
export class NatsAdapter implements MessagingEngineAdapter {
  readonly engines: MessagingEngine[] = ['nats'];

  connect(params: MessagingConnectParams): Promise<MessagingConnection> {
    const http = axios.create({
      baseURL: `http://${params.host}:${params.port}`,
      timeout: 15_000,
    });
    return Promise.resolve(new NatsMonitorConnection(http));
  }

  async connectProtocol(
    params: MessagingConnectParams,
  ): Promise<MessagingProtocolConnection> {
    const nc = await connect({
      servers: `${params.host}:${params.port}`,
      // Matches the family's other adapters; 5s was too tight for a cold
      // port-forward to a JetStream node and caused spurious write failures.
      timeout: 15_000,
      reconnect: false,
      maxReconnectAttempts: 0,
      name: 'flui-console',
    });
    return new NatsProtocolConnection(nc);
  }
}
