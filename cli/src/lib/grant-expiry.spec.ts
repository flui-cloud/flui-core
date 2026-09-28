import { describeExpiry, parseGrantExpiry } from './grant-expiry';

const NOW = new Date('2026-09-28T10:00:00Z');

describe('parseGrantExpiry', () => {
  it('reads durations from now', () => {
    expect(parseGrantExpiry('30m', NOW).toISOString()).toBe(
      '2026-09-28T10:30:00.000Z',
    );
    expect(parseGrantExpiry('8h', NOW).toISOString()).toBe(
      '2026-09-28T18:00:00.000Z',
    );
    expect(parseGrantExpiry('7d', NOW).toISOString()).toBe(
      '2026-10-05T10:00:00.000Z',
    );
    expect(parseGrantExpiry('2w', NOW).toISOString()).toBe(
      '2026-10-12T10:00:00.000Z',
    );
  });

  it('reads a bare date as the end of that day', () => {
    expect(parseGrantExpiry('2026-10-01', NOW).toISOString()).toBe(
      '2026-10-01T23:59:59.000Z',
    );
  });

  it('reads a full timestamp as given', () => {
    expect(parseGrantExpiry('2026-10-01T18:00:00Z', NOW).toISOString()).toBe(
      '2026-10-01T18:00:00.000Z',
    );
  });

  it('refuses the past, zero and nonsense', () => {
    expect(() => parseGrantExpiry('2026-09-01', NOW)).toThrow('future');
    expect(() => parseGrantExpiry('0h', NOW)).toThrow('longer than zero');
    expect(() => parseGrantExpiry('soon', NOW)).toThrow('duration');
  });
});

describe('describeExpiry', () => {
  it('names standing, running and expired grants', () => {
    expect(describeExpiry(null, NOW)).toEqual({
      text: 'standing',
      expired: false,
    });
    expect(describeExpiry('2026-09-28T18:00:00Z', NOW)).toEqual({
      text: 'until 2026-09-28 18:00 UTC',
      expired: false,
    });
    expect(describeExpiry('2026-09-27T18:00:00Z', NOW).expired).toBe(true);
  });
});
