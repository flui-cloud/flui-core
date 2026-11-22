import {
  AckPolicy,
  JetStreamManager,
  NatsError,
  RetentionPolicy,
  StorageType,
  nanos,
} from 'nats';

export interface QueueSpec {
  name: string;
  /** How long a message is kept when nobody handles it. */
  maxAgeHours: number;
  /** Deliveries before a message is given up on. */
  maxDeliver: number;
  /** Keep the messages given up on in `<name>_DLQ`. */
  deadLetter: boolean;
}

export interface QueueView {
  name: string;
  subjects: string[];
  maxAgeHours: number;
  maxDeliver: number;
  /** Messages waiting for the worker. */
  waiting: number;
  /** Delivered, not yet acknowledged. */
  inFlight: number;
  redelivered: number;
  consumers: number;
  /** Messages given up on, or null without a dead-letter queue. */
  deadLetters: number | null;
}

export const deadLetterStream = (name: string): string => `${name}_DLQ`;

/**
 * NATS publishes this advisory when a message reaches its last delivery; a
 * stream on it is the dead-letter queue JetStream does not have natively.
 * It records the stream sequence, so the message itself stays readable.
 */
export const maxDeliveriesAdvisory = (
  stream: string,
  consumer: string,
): string => `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.${consumer}`;

/** A queue is a work-queue stream, one durable consumer the worker pulls from, and optionally its dead letters. */
export async function createQueue(
  jsm: JetStreamManager,
  spec: QueueSpec,
): Promise<void> {
  await jsm.streams.add({
    name: spec.name,
    subjects: [spec.name, `${spec.name}.>`],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    max_age: nanos(spec.maxAgeHours * 3_600_000),
  });
  await jsm.consumers.add(spec.name, {
    durable_name: spec.name,
    ack_policy: AckPolicy.Explicit,
    max_deliver: spec.maxDeliver,
  });
  if (spec.deadLetter) {
    await jsm.streams.add({
      name: deadLetterStream(spec.name),
      subjects: [maxDeliveriesAdvisory(spec.name, spec.name)],
      storage: StorageType.File,
      max_age: nanos(spec.maxAgeHours * 3_600_000),
    });
  }
}

const isNotFound = (e: unknown): boolean =>
  e instanceof NatsError && /not found/i.test(e.message);

export async function listQueues(jsm: JetStreamManager): Promise<QueueView[]> {
  const streams = await jsm.streams.list().next();
  const names = new Set(streams.map((s) => s.config.name));
  const views: QueueView[] = [];
  for (const s of streams) {
    if (s.config.name.endsWith('_DLQ') && names.has(s.config.name.slice(0, -4)))
      continue;
    const consumer = await jsm.consumers
      .info(s.config.name, s.config.name)
      .catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
    const dlq = names.has(deadLetterStream(s.config.name))
      ? (await jsm.streams.info(deadLetterStream(s.config.name))).state.messages
      : null;
    views.push({
      name: s.config.name,
      subjects: s.config.subjects ?? [],
      maxAgeHours: Math.round(s.config.max_age / 3_600_000_000_000),
      maxDeliver: consumer?.config.max_deliver ?? 0,
      waiting: consumer?.num_pending ?? s.state.messages,
      inFlight: consumer?.num_ack_pending ?? 0,
      redelivered: consumer?.num_redelivered ?? 0,
      consumers: s.state.consumer_count,
      deadLetters: dlq,
    });
  }
  return views;
}

export async function deleteQueue(
  jsm: JetStreamManager,
  name: string,
): Promise<void> {
  for (const stream of [name, deadLetterStream(name)]) {
    await jsm.streams
      .delete(stream)
      .catch((e) => (isNotFound(e) ? false : Promise.reject(e)));
  }
}
