import { KafkaEngine, KafkaSaslCredentials } from '../engine/kafka-engine';

export interface KafkaResolveInput {
  appId: string;
  fluiUserId: string;
}

export interface KafkaTarget {
  clusterId: string;
  namespace: string;
  podLabelSelector: string;
  /** In-cluster broker port to port-forward to. */
  port: number;
}

export interface ResolvedKafkaConnection {
  engine: KafkaEngine;
  target: KafkaTarget;
  /** Present only when the broker requires SASL. */
  sasl?: KafkaSaslCredentials;
}

export interface KafkaConnectionInfo {
  engine: KafkaEngine;
  label: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
}
