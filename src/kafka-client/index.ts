/**
 * @flui/kafka-client — a transport-agnostic, multi-broker Kafka client plus a
 * small "kafka-shell" command language. Depends only on `kafkajs` and the Node
 * standard library so it can be extracted into a standalone package unchanged.
 *
 * - {@link KafkaClient}: high-level operations (topics, produce, consume, groups, lag).
 * - {@link parseCommand} + {@link executeCommand}: parse and run kafka-shell lines.
 * - {@link COMMAND_CATALOG}: the grammar, for help text and the AI copilot prompt.
 */

export * from './types';
export * from './commands';
export { KafkaClient } from './client';
export type { KafkaClientOptions } from './client';
export { executeCommand } from './executor';
export type { CommandResult } from './executor';
