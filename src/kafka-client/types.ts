/**
 * Domain types for the Kafka client library. Deliberately free of any Flui or
 * Kubernetes concept so this folder can be lifted into a standalone package: it
 * depends only on `kafkajs` and the Node standard library.
 */

export interface BrokerInfo {
  nodeId: number;
  host: string;
  port: number;
  rack?: string;
}

export interface ClusterInfo {
  clusterId?: string;
  controllerId?: number;
  brokers: BrokerInfo[];
}

export interface PartitionInfo {
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  /** Earliest available offset (log start). */
  low?: string;
  /** Next offset to be produced (log end / high watermark). */
  high?: string;
}

export interface TopicSummary {
  name: string;
  partitions: number;
  replicationFactor: number;
  internal: boolean;
}

export interface TopicConfigEntry {
  name: string;
  value: string | null;
  isDefault: boolean;
}

export interface TopicDetail {
  name: string;
  partitions: PartitionInfo[];
  configs: TopicConfigEntry[];
}

export interface CreateTopicSpec {
  topic: string;
  numPartitions?: number;
  replicationFactor?: number;
}

export interface ProduceSpec {
  topic: string;
  value: string;
  key?: string;
  partition?: number;
}

export interface ProduceResult {
  topic: string;
  partition: number;
  offset?: string;
}

export interface ConsumedMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  timestamp?: string;
  /** How `value`/`key` were decoded; binary payloads come back base64. */
  encoding: 'utf8' | 'base64';
}

export interface ConsumeSpec {
  topic: string;
  /** Read the last N messages across the topic's partitions (newest tail). */
  fromEnd?: number;
  /** Read forward from the earliest N messages of each partition. */
  fromStart?: number;
  /** Restrict to a single partition. */
  partition?: number;
  /** Hard cap on returned messages (defaults to fromEnd/fromStart or 20). */
  limit?: number;
  /** Stop after this many ms with no new records (default 3000). */
  idleMs?: number;
}

export interface GroupSummary {
  groupId: string;
  protocolType?: string;
}

export interface GroupMember {
  memberId: string;
  clientId?: string;
  host?: string;
}

export interface GroupDescription {
  groupId: string;
  state: string;
  protocol?: string;
  members: GroupMember[];
}

export interface PartitionLag {
  topic: string;
  partition: number;
  /** The group's committed offset. */
  current: string;
  /** The partition's high watermark. */
  logEnd: string;
  lag: number;
}

export interface GroupLag {
  groupId: string;
  totalLag: number;
  partitions: PartitionLag[];
}
