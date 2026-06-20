import { KafkaClient } from './client';
import { CommandVerb, ParsedCommand } from './commands';
import { ConsumedMessage } from './types';

/**
 * Normalized result of running one command — the shape the UI renders. `kind`
 * tells the runner whether to draw a table, a message list, a key/value detail,
 * or a plain acknowledgement.
 */
export interface CommandResult {
  command: string;
  verb: CommandVerb;
  mutation: boolean;
  kind: 'table' | 'messages' | 'detail' | 'ack';
  columns?: string[];
  rows?: Array<Array<string | number | null>>;
  messages?: ConsumedMessage[];
  detail?: Record<string, unknown>;
  text?: string;
}

/** Run a parsed kafka-shell command against the client and normalize the result. */
export async function executeCommand(
  client: KafkaClient,
  cmd: ParsedCommand,
): Promise<CommandResult> {
  const base = { command: cmd.raw, verb: cmd.verb, mutation: cmd.mutation };

  switch (cmd.verb) {
    case 'cluster.info': {
      const c = await client.clusterInfo();
      return {
        ...base,
        kind: 'detail',
        detail: {
          clusterId: c.clusterId,
          controllerId: c.controllerId,
          brokers: c.brokers,
        },
      };
    }

    case 'topics.list': {
      const topics = await client.listTopics();
      return {
        ...base,
        kind: 'table',
        columns: ['topic', 'partitions', 'replication', 'internal'],
        rows: topics.map((t) => [
          t.name,
          t.partitions,
          t.replicationFactor,
          t.internal ? 'yes' : '',
        ]),
        text: `${topics.length} topic(s)`,
      };
    }

    case 'topic.describe': {
      const d = await client.describeTopic(cmd.topic);
      return {
        ...base,
        kind: 'detail',
        detail: { name: d.name, partitions: d.partitions, configs: d.configs },
      };
    }

    case 'topic.create': {
      const r = await client.createTopic({
        topic: cmd.topic,
        numPartitions: cmd.partitions,
        replicationFactor: cmd.replication,
      });
      return {
        ...base,
        kind: 'ack',
        text: r.created
          ? `Created topic "${cmd.topic}".`
          : `Topic "${cmd.topic}" already exists.`,
      };
    }

    case 'topic.delete': {
      await client.deleteTopic(cmd.topic);
      return { ...base, kind: 'ack', text: `Deleted topic "${cmd.topic}".` };
    }

    case 'produce': {
      const r = await client.produce({
        topic: cmd.topic,
        value: cmd.value,
        key: cmd.key,
        partition: cmd.partition,
      });
      const offsetSuffix =
        r.offset === undefined ? '' : ` @ offset ${r.offset}`;
      return {
        ...base,
        kind: 'ack',
        text: `Produced to ${r.topic}[${r.partition}]${offsetSuffix}.`,
      };
    }

    case 'consume': {
      const messages = await client.consume({
        topic: cmd.topic,
        fromEnd: cmd.fromEnd,
        fromStart: cmd.fromStart,
        partition: cmd.partition,
        limit: cmd.limit,
      });
      return {
        ...base,
        kind: 'messages',
        messages,
        text: `${messages.length} record(s)`,
      };
    }

    case 'groups.list': {
      const groups = await client.listGroups();
      return {
        ...base,
        kind: 'table',
        columns: ['group', 'protocolType'],
        rows: groups.map((g) => [g.groupId, g.protocolType ?? '']),
        text: `${groups.length} group(s)`,
      };
    }

    case 'group.describe': {
      const g = await client.describeGroup(cmd.group);
      return {
        ...base,
        kind: 'detail',
        detail: {
          groupId: g.groupId,
          state: g.state,
          protocol: g.protocol,
          members: g.members,
        },
      };
    }

    case 'group.lag': {
      const lag = await client.groupLag(cmd.group);
      return {
        ...base,
        kind: 'table',
        columns: ['topic', 'partition', 'current', 'logEnd', 'lag'],
        rows: lag.partitions.map((p) => [
          p.topic,
          p.partition,
          p.current,
          p.logEnd,
          p.lag,
        ]),
        text: `total lag ${lag.totalLag}`,
      };
    }

    default: {
      // Exhaustiveness guard — every CommandVerb is handled above.
      throw new Error(`Unhandled command verb: ${cmd.verb}`);
    }
  }
}
