jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import { visitorLines } from './visitor-stats-format';

describe('visitorLines', () => {
  it('shows the entrance in plain words, with only the reasons that happened', () => {
    const lines = visitorLines({
      entranceOpen: true,
      visitorsNow: 4,
      poolReady: 2,
      poolMin: 3,
      upgraded: 1,
      merged: 0,
      last24h: {
        created: 9,
        refused: 6,
        refusedByReason: [
          { reason: 'limit-ip', count: 5 },
          { reason: 'challenge', count: 1 },
          { reason: 'something-new', count: 0 },
        ],
      },
    }).map((l) => l.replace(/\s+/g, ' ').trim());
    expect(lines).toEqual([
      'Entrance open',
      'Visitors now 4',
      'Ready ahead of time 2 of 3',
      'Came in, last 24 h 9',
      'Turned away, last 24 h 6 (per-address limit 5, browser check failed 1)',
      'Became accounts 1',
      'Added to accounts 0',
    ]);
  });
});
