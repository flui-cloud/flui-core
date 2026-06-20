/**
 * Messaging engine family. NATS/JetStream (unauthenticated monitoring API) and
 * RabbitMQ (authenticated management HTTP API). The console speaks an
 * engine-neutral contract — queues map to "streams", routing keys to "subjects".
 */
export type MessagingEngine = 'nats' | 'rabbitmq';

export interface MessagingServerInfo {
  serverName: string;
  version: string;
  uptime: string;
  connections: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  memBytes: number;
  cores: number;
  jetStream: {
    enabled: boolean;
    memoryBytes: number;
    storageBytes: number;
    accounts: number;
    apiTotal: number;
    apiErrors: number;
  };
}

export interface JsConsumer {
  name: string;
  stream: string;
  numPending: number;
  numAckPending: number;
  numRedelivered: number;
  numWaiting: number;
  deliveredStreamSeq: number;
  ackFloorStreamSeq: number;
  ackPolicy?: string;
  deliverPolicy?: string;
  durable: boolean;
}

export interface JsStream {
  name: string;
  account: string;
  subjects: string[];
  retention?: string;
  storage?: string;
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  consumerCount: number;
  consumers: JsConsumer[];
}

export interface MessagingConnectParams {
  host: string;
  port: number;
  /** Set for engines with an authenticated API (RabbitMQ); absent for NATS. */
  username?: string;
  password?: string;
}

/** A live, read-only monitoring session against one messaging server. */
export interface MessagingConnection {
  serverInfo(): Promise<MessagingServerInfo>;
  /** Every JetStream stream with its consumers embedded (one monitoring call). */
  streams(): Promise<JsStream[]>;
  close(): Promise<void>;
}

/**
 * One stored message peeked from a stream/queue. Engine-agnostic so the same UI
 * serves NATS today and other brokers (RabbitMQ, …) later. `data` is the UTF-8
 * decoding when the payload is text; binary payloads come back base64 with
 * `encoding: 'base64'`.
 */
export interface QueueMessage {
  seq?: number;
  subject: string;
  data: string;
  encoding: 'utf8' | 'base64';
  timestamp?: string;
  headers?: Record<string, string[]>;
}

export interface PublishTarget {
  /** NATS subject / future broker routing key. */
  subject: string;
  payload: string;
  headers?: Record<string, string>;
}

export interface PublishResult {
  stream?: string;
  seq?: number;
}

export interface PeekOptions {
  /** Stream/queue to read from. */
  stream: string;
  limit: number;
  /** Optional starting sequence; default is the tail (most recent). */
  startSeq?: number;
}

/**
 * Engine-neutral stream/queue descriptor + create spec. NATS JetStream streams
 * today; the same shape maps to a future broker's durable queue/topic. A stream
 * must exist (covering the subject) before publish/peek can work — managing
 * streams is what makes the produce/peek path usable.
 */
export interface QueueStream {
  name: string;
  subjects: string[];
  storage?: string;
  retention?: string;
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  consumerCount: number;
}

export interface CreateStreamInput {
  name: string;
  subjects: string[];
  /** Backing store; defaults to durable file storage. */
  storage?: 'file' | 'memory';
  /** Retention policy (NATS: limits | workqueue | interest). Default limits. */
  retention?: 'limits' | 'workqueue' | 'interest';
  maxMsgs?: number;
  maxBytes?: number;
  maxAgeSeconds?: number;
}

/**
 * A live protocol session for produce/peek + stream management. Non-destructive:
 * `peek` reads stored messages by sequence without acking, so it never steals
 * delivery from real consumers. `publish`, `createStream` and `deleteStream` are
 * the writes the console performs.
 */
export interface MessagingProtocolConnection {
  publish(target: PublishTarget): Promise<PublishResult>;
  peek(opts: PeekOptions): Promise<QueueMessage[]>;
  listStreams(): Promise<QueueStream[]>;
  createStream(spec: CreateStreamInput): Promise<QueueStream>;
  deleteStream(name: string): Promise<void>;
  close(): Promise<void>;
}

export interface MessagingEngineAdapter {
  readonly engines: MessagingEngine[];
  /** Monitoring session (HTTP /varz, /jsz) — server stats + streams. */
  connect(params: MessagingConnectParams): Promise<MessagingConnection>;
  /** Protocol session (client port) — publish + non-destructive peek. */
  connectProtocol(
    params: MessagingConnectParams,
  ): Promise<MessagingProtocolConnection>;
}

export const MESSAGING_ENGINE_ADAPTERS = Symbol('MESSAGING_ENGINE_ADAPTERS');

/** How to read the engine's credentials from the install (for authed APIs). */
export interface MessagingAuthProfile {
  /** Env var(s) holding the username; first present wins. */
  userEnvKeys: string[];
  /** Username to use when no env is set (the broker's default). */
  defaultUser: string;
  /** Secret key(s) holding the password; first present wins. */
  passwordSecretKeys: string[];
}

export interface MessagingProfile {
  engine: MessagingEngine;
  label: string;
  /** In-cluster HTTP monitoring/management port. */
  monitoringPort: number;
  /** In-cluster client/protocol port (publish + peek). */
  clientPort: number;
  imagePattern: RegExp;
  /** Present when the engine's API is authenticated (RabbitMQ); absent for NATS. */
  auth?: MessagingAuthProfile;
}

export const MESSAGING_PROFILES: Record<MessagingEngine, MessagingProfile> = {
  nats: {
    engine: 'nats',
    label: 'NATS',
    monitoringPort: 8222,
    clientPort: 4222,
    imagePattern: /nats/i,
  },
  // RabbitMQ does everything over the management HTTP API (:15672) — stats,
  // queue/binding management, publish and non-destructive get — so both the
  // monitoring and protocol ports point at it. Authenticated with the broker's
  // generated owner credentials.
  rabbitmq: {
    engine: 'rabbitmq',
    label: 'RabbitMQ',
    monitoringPort: 15672,
    clientPort: 15672,
    imagePattern: /rabbitmq/i,
    auth: {
      userEnvKeys: ['RABBITMQ_DEFAULT_USER'],
      defaultUser: 'guest',
      passwordSecretKeys: ['RABBITMQ_DEFAULT_PASS'],
    },
  },
};

export function detectMessagingEngine(
  imageRef?: string,
): MessagingEngine | null {
  if (!imageRef) return null;
  for (const profile of Object.values(MESSAGING_PROFILES)) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}
