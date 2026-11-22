import { deadLetterStream } from './queue-ops';

export interface QueueBacklog {
  /** Public key of the account, which names it on the server. */
  account: string;
  queue: string;
  waiting: number;
}

interface JszConsumer {
  name: string;
  num_pending?: number;
}

interface JszStream {
  name: string;
  state?: { messages?: number };
  consumer_detail?: JszConsumer[];
}

interface JszAccount {
  /** The public key in operator mode; `name` is then the name in the account JWT. */
  id?: string;
  name: string;
  stream_detail?: JszStream[];
}

export interface JszReply {
  data?: { account_details?: JszAccount[] };
}

/** Request for `$SYS.REQ.SERVER.PING.JSZ`: every account, its streams and their consumers. */
export const JSZ_SUBJECT = '$SYS.REQ.SERVER.PING.JSZ';
export const JSZ_REQUEST = { accounts: true, streams: true, consumer: true };

/** What waits in each queue, read the way the Messaging tab reads it: the durable consumer named after the stream. */
export function backlogOf(reply: JszReply): QueueBacklog[] {
  const rows: QueueBacklog[] = [];
  for (const account of reply.data?.account_details ?? []) {
    const streams = account.stream_detail ?? [];
    const names = new Set(streams.map((s) => s.name));
    for (const stream of streams) {
      const base = stream.name.slice(0, -4);
      if (names.has(base) && deadLetterStream(base) === stream.name) continue;
      const consumer = stream.consumer_detail?.find(
        (c) => c.name === stream.name,
      );
      rows.push({
        account: account.id ?? account.name,
        queue: stream.name,
        waiting: consumer?.num_pending ?? stream.state?.messages ?? 0,
      });
    }
  }
  return rows;
}

export interface QueueAlarmSettings {
  /** Below this many waiting messages a queue is never news. */
  minWaiting: number;
  /** Consecutive readings that must each be higher than the one before. */
  samples: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function queueAlarmSettings(
  env: NodeJS.ProcessEnv = process.env,
): QueueAlarmSettings {
  return {
    minWaiting: positive(env.QUEUE_ALERT_MIN_WAITING, 100),
    samples: Math.max(2, positive(env.QUEUE_ALERT_SAMPLES, 4)),
  };
}

export type QueueVerdict = 'growing' | 'draining' | 'steady';

/**
 * `growing` when each of the last readings rose and the latest is above the
 * floor; `draining` once it falls or drops under the floor. A queue that holds
 * still stays as it was: a backlog that stopped growing has not cleared.
 */
export function judgeQueue(
  readings: number[],
  settings: QueueAlarmSettings,
): QueueVerdict {
  const latest = readings.at(-1);
  if (latest === undefined) return 'steady';
  const previous = readings.at(-2);
  if (
    latest < settings.minWaiting ||
    (previous !== undefined && latest < previous)
  ) {
    return 'draining';
  }
  const recent = readings.slice(-settings.samples);
  if (recent.length < settings.samples) return 'steady';
  const rising = recent.every((value, i) => i === 0 || value > recent[i - 1]);
  return rising ? 'growing' : 'steady';
}
