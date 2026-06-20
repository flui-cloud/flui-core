/**
 * Kafka engine family. Unlike the messaging family (NATS/RabbitMQ, publish/peek),
 * the Kafka console is command-driven (kafka-shell) and admin-rich (topics,
 * consumer groups, lag). The protocol work lives in the standalone, Flui-free
 * `src/kafka-client` library; this file only declares how Flui discovers and
 * reaches an installed Kafka.
 */
export type KafkaEngine = 'kafka';

export interface KafkaSaslCredentials {
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username: string;
  password: string;
}

/** How a query service hands the adapter a reachable endpoint (the tunnel). */
export interface KafkaConnectParams {
  host: string;
  port: number;
  ssl?: boolean;
  sasl?: KafkaSaslCredentials;
}

export interface KafkaAuthProfile {
  userEnvKeys: string[];
  defaultUser: string;
  passwordSecretKeys: string[];
  mechanism: KafkaSaslCredentials['mechanism'];
}

export interface KafkaProfile {
  engine: KafkaEngine;
  label: string;
  /** In-cluster client/broker port (the PLAINTEXT listener). */
  clientPort: number;
  imagePattern: RegExp;
  /** Present only when the broker requires SASL; absent for a PLAINTEXT building block. */
  auth?: KafkaAuthProfile;
}

export const KAFKA_PROFILES: Record<KafkaEngine, KafkaProfile> = {
  kafka: {
    engine: 'kafka',
    label: 'Apache Kafka',
    clientPort: 9092,
    imagePattern: /(^|\/)kafka(-native)?(:|$)|apache\/kafka/i,
  },
};

export function detectKafkaEngine(imageRef?: string): KafkaEngine | null {
  if (!imageRef) return null;
  for (const profile of Object.values(KAFKA_PROFILES)) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}
