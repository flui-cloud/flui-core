jest.mock('@kubernetes/client-node', () => ({}));

import { JSONCodec } from 'nats';
import {
  fingerprintOf,
  QueueAlarmService,
  QUEUE_GROWING_ALERT,
} from './queue-alarm.service';

const OPERATOR = {
  clusterId: 'c1',
  systemAccountSeed: 'enc:sys',
} as never;

function build() {
  let waiting = 0;
  const open: Array<Record<string, unknown>> = [];
  const request = jest.fn(async () => ({
    data: JSONCodec().encode({
      data: {
        account_details: [
          {
            id: 'AAPP',
            name: 'shop',
            stream_detail: [
              {
                name: 'jobs',
                consumer_detail: [{ name: 'jobs', num_pending: waiting }],
              },
            ],
          },
          {
            name: 'AFOREIGN',
            stream_detail: [{ name: 'x', state: { messages: 9999 } }],
          },
        ],
      },
    }),
  }));
  const nats = {
    withConnection: jest.fn(
      async (
        _c: string,
        _s: string,
        _n: string,
        work: (nc: unknown) => unknown,
      ) => work({ request }),
    ),
  };
  const recorded: Array<Record<string, unknown>> = [];
  const recorder = {
    record: jest.fn(async (alerts: Array<Record<string, unknown>>) => {
      recorded.push(...alerts);
      return alerts
        .map((a) => {
          if (a.status === 'firing') {
            const already = open.some((o) => o.fingerprint === a.fingerprint);
            if (!already) open.push({ ...a });
            return already ? null : { kind: 'fired', event: a };
          }
          open.splice(
            open.findIndex((o) => o.fingerprint === a.fingerprint),
            1,
          );
          return { kind: 'resolved', event: a };
        })
        .filter(Boolean);
    }),
  };
  const routing = { deliver: jest.fn(async () => undefined) };
  const moduleRef = {
    get: (token: { name: string }) =>
      token.name === 'AlertEventsService' ? recorder : routing,
  };
  const service = new QueueAlarmService(
    { find: async () => [OPERATOR] } as never,
    {
      find: async () => [
        { publicKey: 'AAPP', applicationId: 'app-1', clusterId: 'c1' },
      ],
    } as never,
    {
      find: async () => [
        { id: 'app-1', name: 'Shop', slug: 'shop', userId: 'owner-1' },
      ],
    } as never,
    { find: async () => open } as never,
    nats as never,
    moduleRef as never,
  );
  return {
    service,
    nats,
    recorded,
    routing,
    setWaiting: (n: number) => (waiting = n),
  };
}

describe('the alarm on a queue that keeps growing', () => {
  const previous = process.env.QUEUE_ALERT_SAMPLES;
  beforeAll(() => (process.env.QUEUE_ALERT_SAMPLES = '3'));
  afterAll(() => (process.env.QUEUE_ALERT_SAMPLES = previous));

  async function round(
    ctx: ReturnType<typeof build>,
    waiting: number,
  ): Promise<void> {
    ctx.setWaiting(waiting);
    await ctx.service.tick();
  }

  it('reads every account once per cluster as the system account', async () => {
    const ctx = build();
    await round(ctx, 5);
    expect(ctx.nats.withConnection).toHaveBeenCalledTimes(1);
    expect(ctx.nats.withConnection.mock.calls[0].slice(0, 2)).toEqual([
      'c1',
      'enc:sys',
    ]);
  });

  it('fires to the owner after three rising readings above the floor, and only for accounts Flui knows', async () => {
    const ctx = build();
    await round(ctx, 150);
    await round(ctx, 300);
    expect(ctx.recorded).toEqual([]);
    await round(ctx, 450);
    expect(ctx.recorded).toHaveLength(1);
    expect(ctx.recorded[0]).toMatchObject({
      fingerprint: fingerprintOf({ account: 'AAPP', queue: 'jobs' }),
      status: 'firing',
      alertname: QUEUE_GROWING_ALERT,
      fluiKind: 'queue',
      applicationId: 'app-1',
      clusterId: 'c1',
    });
    expect(ctx.routing.deliver).toHaveBeenCalledWith(
      'fired',
      expect.anything(),
      { ownerUserId: 'owner-1' },
    );
  });

  it('names a queue in a fingerprint the alert table can hold', () => {
    const account = 'A'.padEnd(56, 'B');
    const one = fingerprintOf({ account, queue: 'ORDERS_WITH_A_LONG_NAME' });
    expect(one.length).toBeLessThanOrEqual(64);
    expect(one).toBe(
      fingerprintOf({ account, queue: 'ORDERS_WITH_A_LONG_NAME' }),
    );
    expect(one).not.toBe(fingerprintOf({ account, queue: 'OTHER' }));
  });

  it('stays open while the backlog holds and resolves once it drains', async () => {
    const ctx = build();
    for (const n of [150, 300, 450]) await round(ctx, n);
    await round(ctx, 450);
    expect(ctx.recorded.at(-1)).toMatchObject({ status: 'firing' });
    expect(ctx.routing.deliver).toHaveBeenCalledTimes(1);
    await round(ctx, 200);
    expect(ctx.recorded.at(-1)).toMatchObject({
      fingerprint: fingerprintOf({ account: 'AAPP', queue: 'jobs' }),
      status: 'resolved',
    });
    expect(ctx.routing.deliver).toHaveBeenLastCalledWith(
      'resolved',
      expect.anything(),
      { ownerUserId: 'owner-1' },
    );
  });

  it('never stops the round when a cluster cannot be read', async () => {
    const ctx = build();
    ctx.nats.withConnection.mockRejectedValueOnce(new Error('no tunnel'));
    await expect(ctx.service.tick()).resolves.toBeUndefined();
  });
});
