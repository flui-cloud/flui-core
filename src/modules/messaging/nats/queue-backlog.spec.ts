import { backlogOf, judgeQueue, queueAlarmSettings } from './queue-backlog';

const SETTINGS = { minWaiting: 100, samples: 3 };

describe('queue backlog', () => {
  it('reads what waits for the durable consumer named after each queue, skipping its dead letters', () => {
    const rows = backlogOf({
      data: {
        account_details: [
          {
            id: 'AAPP',
            name: 'shop',
            stream_detail: [
              {
                name: 'jobs',
                state: { messages: 50 },
                consumer_detail: [
                  { name: 'other', num_pending: 1 },
                  { name: 'jobs', num_pending: 42 },
                ],
              },
              { name: 'jobs_DLQ', state: { messages: 3 } },
              { name: 'raw', state: { messages: 7 } },
            ],
          },
          { name: 'AEMPTY' },
        ],
      },
    });
    expect(rows).toEqual([
      { account: 'AAPP', queue: 'jobs', waiting: 42 },
      { account: 'AAPP', queue: 'raw', waiting: 7 },
    ]);
  });

  it('keeps a stream named like a dead-letter queue when there is no queue it belongs to', () => {
    const rows = backlogOf({
      data: {
        account_details: [
          {
            name: 'A',
            stream_detail: [{ name: 'orders_DLQ', state: { messages: 2 } }],
          },
        ],
      },
    });
    expect(rows).toEqual([{ account: 'A', queue: 'orders_DLQ', waiting: 2 }]);
  });

  it.each([
    [[120, 130, 140], 'growing'],
    [[90, 130, 140, 150], 'growing'],
    [[120, 130], 'steady'],
    [[120, 130, 130], 'steady'],
    [[120, 150, 140], 'draining'],
    [[200, 300, 90], 'draining'],
    [[10, 20, 30], 'draining'],
    [[], 'steady'],
  ])('judges %j as %s', (readings, verdict) => {
    expect(judgeQueue(readings, SETTINGS)).toBe(verdict);
  });

  it('takes its thresholds from the environment, never fewer than two readings', () => {
    expect(queueAlarmSettings({})).toEqual({ minWaiting: 100, samples: 4 });
    expect(
      queueAlarmSettings({
        QUEUE_ALERT_MIN_WAITING: '500',
        QUEUE_ALERT_SAMPLES: '1',
      }),
    ).toEqual({ minWaiting: 500, samples: 2 });
    expect(
      queueAlarmSettings({ QUEUE_ALERT_MIN_WAITING: 'x' }).minWaiting,
    ).toBe(100);
  });
});
