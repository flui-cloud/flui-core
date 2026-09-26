import {
  describeWindow,
  effectiveWindow,
  isOpen,
  nextOpening,
  windowProblems,
  settleDeferredProposal,
  MaintenanceWindow,
} from './maintenance-window.core';

const tuesdayNight: MaintenanceWindow = {
  timezone: 'UTC',
  slots: [{ days: ['tue'], start: '02:00', durationMinutes: 120 }],
};

describe('nextOpening', () => {
  it('finds the next slot later in the week', () => {
    // 2026-09-26 is a Saturday.
    expect(
      nextOpening(
        tuesdayNight,
        new Date('2026-09-26T10:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-09-29T02:00:00.000Z');
  });

  it('answers now while a slot is open', () => {
    const now = new Date('2026-09-29T03:10:00Z');
    expect(nextOpening(tuesdayNight, now)?.toISOString()).toBe(
      now.toISOString(),
    );
    expect(isOpen(tuesdayNight, now)).toBe(true);
  });

  it('moves to the following week once the slot has closed', () => {
    expect(
      nextOpening(
        tuesdayNight,
        new Date('2026-09-29T04:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-10-06T02:00:00.000Z');
  });

  it('reads the start in the window time zone, summer time included', () => {
    const rome: MaintenanceWindow = {
      timezone: 'Europe/Rome',
      slots: [{ days: ['sun'], start: '03:00', durationMinutes: 60 }],
    };
    // 03:00 in Rome on 27 Sep 2026 is 01:00 UTC (CEST, +2).
    expect(
      nextOpening(rome, new Date('2026-09-26T10:00:00Z'))?.toISOString(),
    ).toBe('2026-09-27T01:00:00.000Z');
  });

  it('keeps a slot that started yesterday and runs past midnight', () => {
    const late: MaintenanceWindow = {
      timezone: 'UTC',
      slots: [{ days: ['fri'], start: '23:00', durationMinutes: 180 }],
    };
    const now = new Date('2026-09-26T01:00:00Z');
    expect(isOpen(late, now)).toBe(true);
  });
});

describe('effectiveWindow', () => {
  it('follows the cluster by default', () => {
    expect(effectiveWindow(tuesdayNight, null)).toMatchObject({
      kind: 'window',
      source: 'cluster',
    });
  });

  it('says why nothing can wait when the cluster has no window', () => {
    expect(effectiveWindow(null, { mode: 'follow' })).toEqual({
      kind: 'none',
      reason: 'Set a maintenance window on the cluster first.',
    });
  });

  it('prefers the application slot, and lets it opt out', () => {
    const own = {
      timezone: 'UTC',
      slots: [{ days: ['sun' as const], start: '05:00', durationMinutes: 30 }],
    };
    expect(
      effectiveWindow(tuesdayNight, { mode: 'own', window: own }),
    ).toMatchObject({ source: 'app' });
    expect(effectiveWindow(tuesdayNight, { mode: 'anytime' })).toEqual({
      kind: 'anytime',
    });
  });
});

describe('windowProblems and describeWindow', () => {
  it('names each problem', () => {
    expect(
      windowProblems({
        timezone: 'Mars/Olympus',
        slots: [{ days: [], start: '25:00', durationMinutes: 5 }],
      }),
    ).toHaveLength(4);
    expect(windowProblems(tuesdayNight)).toEqual([]);
  });

  it('reads as a person would say it', () => {
    expect(describeWindow(tuesdayNight)).toBe('tue 02:00–04:00 UTC');
  });
});

describe('settleDeferredProposal', () => {
  it('drops a change nothing asks for any more', () => {
    expect(settleDeferredProposal({ proposal: null }).status).toBe('discarded');
  });

  it('applies when there is room, or a group that buys it', () => {
    expect(
      settleDeferredProposal({
        proposal: { problem: null, verdict: 'fits', sentence: '' },
      }),
    ).toEqual({ status: 'apply' });
    expect(
      settleDeferredProposal({
        proposal: { problem: null, verdict: 'buys', sentence: '' },
      }),
    ).toEqual({ status: 'apply' });
  });

  it('raises instead of applying when it would need a machine nobody buys', () => {
    const v = settleDeferredProposal({
      proposal: {
        problem: null,
        verdict: 'proposes',
        sentence: 'The group would name a cx33 and buy nothing.',
      },
    });
    expect(v).toEqual({
      status: 'alerted',
      outcome:
        'Not applied, because the application would have nowhere to run: The group would name a cx33 and buy nothing.',
    });
  });

  it('fails a change the values would refuse', () => {
    expect(
      settleDeferredProposal({
        proposal: {
          problem: 'limit below request',
          verdict: 'fits',
          sentence: '',
        },
      }).status,
    ).toBe('failed');
  });
});
